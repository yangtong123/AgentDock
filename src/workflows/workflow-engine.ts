import { randomUUID } from "node:crypto";
import type { RunState, StepRun, Task, TaskRevision, WorkflowRun } from "../shared/domain.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import type { WorkflowRepository } from "./workflow-repository.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import type { ArtifactRepository } from "../artifacts/artifact-repository.js";
import type { AgentThreadManager } from "../runtime/agent-thread-manager.js";
import { expandPreset, DEFAULT_PROVIDERS, type ProviderAssignment } from "./presets.js";
import { ProcessRunner } from "../runtime/process-runner.js";
import { agentEnvironment } from "../runtime/env-agents.js";
import { parseReviewReport, renderFindings, DEFAULT_MAX_REVIEW_ROUNDS, validateMaxReviewRounds, DEFAULT_SESSION_POLICIES, type SessionPolicy, type ReviewFinding } from "./review-findings.js";

export interface StartWorkflowInput {
  taskId: string;
  preset: string;
  providers?: ProviderAssignment;
  stepTimeoutMs?: number;
  maxReviewRounds?: number;
}

export interface WorkflowStatus {
  run: WorkflowRun;
  steps: StepRun[];
  /** Set when execute() returned because a HUMAN_APPROVAL gate is pending. */
  awaitingApproval: boolean;
}

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The orchestrator owns workflow state, retries, approvals, and cancellation.
 * execute() advances one run through its step sequence until it finishes or
 * pauses at a HUMAN_APPROVAL gate; approve()/reject() releases the gate.
 * Runs are pinned to the task revision captured at start(), so revising a
 * task mid-run never retargets an in-flight workflow. VERIFY runs the
 * project's deterministic verify command — higher authority than LLM review.
 *
 * Review/fix loops are bounded by maxReviewRounds: when REVIEW returns
 * NEEDS_FIXES the engine re-runs the FIX->VERIFY->REVIEW block up to the
 * bound, then fails rather than looping forever.
 */
export class WorkflowEngine {
  /** External fix instructions (e.g. GitHub CI failures / PR review feedback). */
  private readonly fixInstructions: (taskId: string) => string | null;
  /** Optional metrics recorder; null keeps the engine dependency-free in tests. */
  private readonly metrics: { recordStepDuration(stepRunId: string, durationMs: number): void } | null;
  private readonly usage: ((entry: { taskId: string; provider: string; role: string; durationMs: number }) => void) | null;
  private readonly budgetGuard: (taskId: string) => { ok: boolean; reason?: string } | null;

  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly runtime: AgentThreadManager,
    private readonly artifacts: ArtifactRepository,
    private readonly verifyRunner: ProcessRunner,
    baseEnv: NodeJS.ProcessEnv = process.env,
    now: () => string = () => new Date().toISOString(),
    fixInstructions: (taskId: string) => string | null = () => null,
    observability: { metrics?: { recordStepDuration(stepRunId: string, durationMs: number): void }; usage?: (entry: { taskId: string; provider: string; role: string; durationMs: number }) => void; budgetGuard?: (taskId: string) => { ok: boolean; reason?: string } | null } = {},
  ) {
    this.baseEnv = baseEnv;
    this.now = now;
    this.fixInstructions = fixInstructions;
    this.metrics = observability.metrics ?? null;
    this.usage = observability.usage ?? null;
    this.budgetGuard = observability.budgetGuard ?? (() => null);
  }

  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly now: () => string;

  async start(input: StartWorkflowInput): Promise<WorkflowStatus> {
    const task = this.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (task.state !== "READY") throw new ValidationError(`Task ${input.taskId} is ${task.state}; workflows start from READY tasks`);
    const steps = expandPreset(input.preset, input.providers);
    const revision = this.tasks.findRevision(task.id, task.currentRevision);
    if (!revision) throw new NotFoundError(`Task ${task.id} revision ${task.currentRevision} not found`);
    validateMaxReviewRounds(input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS);

    const timestamp = this.now();
    const run: WorkflowRun = { id: randomUUID(), taskRevisionId: revision.id, preset: input.preset, state: "QUEUED", maxReviewRounds: input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS, stepTimeoutMs: input.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, createdAt: timestamp, updatedAt: timestamp };
    this.workflows.createRun(run);
    this.tasks.update(task.id, { state: "RUNNING" }, timestamp);
    for (const [index, step] of steps.entries()) {
      this.workflows.createStep({ id: randomUUID(), workflowRunId: run.id, stepType: step.stepType, state: "QUEUED", provider: step.provider, sequence: index, createdAt: timestamp, updatedAt: timestamp });
    }
    return { run, steps: this.workflows.listSteps(run.id), awaitingApproval: false };
  }

  async execute(runId: string): Promise<WorkflowStatus> {
    this.requireResumable(runId);
    const { task, revision } = this.contextForRun(runId);
    const run = this.requireRun(runId);
    const maxRounds = run.maxReviewRounds;
    const stepTimeoutMs = run.stepTimeoutMs;

    this.workflows.updateRun(runId, { state: "RUNNING", updatedAt: this.now() });
    const threads = new Map<string, string>(); // role -> thread id, for RESUME session policy
    let fixProvider = this.workflows.listSteps(runId).find((s) => s.stepType === "FIX")?.provider ?? null;
    let reviewProvider = this.workflows.listSteps(runId).find((s) => s.stepType === "REVIEW")?.provider ?? null;
    // Findings survive in the task's review artifacts; load the latest REVIEW's findings.
    let openFindings = await this.latestReviewFindings(run, task.id);
    while (true) {
      const steps = this.workflows.listSteps(runId);
      const next = steps.find((step) => step.state !== "SUCCEEDED" && step.state !== "CANCELLED");
      if (next === undefined) break;
      // Re-check run state each iteration: a concurrent cancel()/approve() must win.
      if (this.requireRun(runId).state === "CANCELLED") return this.status(runId);
      // Loop bound derives from durable REVIEW steps, so crash/resume can never exceed it.
      const reviewRound = steps.filter((s) => s.stepType === "REVIEW" && s.state === "SUCCEEDED").length;

      if (next.stepType === "FIX" && openFindings.length === 0) {
        // Review passed: the first FIX and everything up to FINAL_REVIEW is unnecessary.
        for (const step of steps.filter((s) => s.sequence >= next.sequence)) {
          if (step.stepType === "FINAL_REVIEW" || step.stepType === "HUMAN_APPROVAL") break;
          this.workflows.updateStep(step.id, { state: "SUCCEEDED", updatedAt: this.now() });
        }
        continue;
      }

      const outcome = await this.executeStep(runId, next, task, revision, openFindings, threads, stepTimeoutMs);
      if (outcome.paused) return { run: this.requireRun(runId), steps: this.workflows.listSteps(runId), awaitingApproval: true };
      if (outcome.state === "FAILED") return this.finishIfNotCancelled(runId, task, "FAILED");
      if (next.stepType === "REVIEW") {
        reviewProvider = next.provider;
        const needsFixes = outcome.review?.verdict === "NEEDS_FIXES";
        openFindings = needsFixes ? (outcome.review?.findings ?? []) : [];
        if (needsFixes) {
          await this.persistFindings(run, task.id, next.id, outcome.review!.findings);
          // reviewRound was snapshotted before this REVIEW succeeded; this run is the latest round.
          if (reviewRound + 1 >= maxRounds) {
            // Bounded loop exhausted: fail instead of reviewing forever.
            this.stepStateUnlessCancelled(runId, next.id, "FAILED");
            return this.finishIfNotCancelled(runId, task, "FAILED");
          }
          // Another round: append FIX -> VERIFY -> REVIEW before FINAL_REVIEW.
          this.appendLoopRound(runId, next, reviewProvider, fixProvider);
        } else {
          openFindings = [];
        }
      }
      if (next.stepType === "FIX") fixProvider = next.provider;
    }
    return this.finishIfNotCancelled(runId, task, "SUCCEEDED");
  }

  /** Dynamically appends one bounded FIX->VERIFY->REVIEW round after the anchor step. */
  private appendLoopRound(runId: string, anchor: StepRun, reviewProvider: string | null, fixProvider: string | null): void {
    // A concurrent cancel() wins: never mutate a cancelled run's plan.
    if (this.requireRun(runId).state === "CANCELLED") return;
    const timestamp = this.now();
    const ordered = this.workflows.listSteps(runId).sort((a, b) => a.sequence - b.sequence);
    const anchorIndex = ordered.findIndex((s) => s.id === anchor.id);
    const round: ("FIX" | "VERIFY" | "REVIEW")[] = ["FIX", "VERIFY", "REVIEW"];
    const before = ordered.slice(0, anchorIndex + 1);
    const tails = ordered.slice(anchorIndex + 1);
    const roundSteps: { id: string; sequence: number; stepType: "FIX" | "VERIFY" | "REVIEW"; provider: string | null }[] = round.map((stepType, index) => ({
      id: randomUUID(), sequence: before.length + index, stepType,
      provider: stepType === "FIX" ? (fixProvider ?? DEFAULT_PROVIDERS.FIX) : stepType === "REVIEW" ? (reviewProvider ?? DEFAULT_PROVIDERS.REVIEW) : null,
    }));
    const finalOrder = [...before, ...roundSteps, ...tails];
    // Create the new steps at tail-end sequences first (no collision), then reorder atomically.
    const base = ordered.length ? Math.max(...ordered.map((s) => s.sequence)) + 1 : 0;
    for (const [index, step] of roundSteps.entries()) {
      this.workflows.createStep({ id: step.id, workflowRunId: runId, stepType: step.stepType, state: "QUEUED", provider: step.provider, sequence: base + index, createdAt: timestamp, updatedAt: timestamp });
    }
    this.workflows.reorderSteps(runId, finalOrder.map((s) => s.id));
  }

  /** Findings are durable: stored as an INLINE artifact so crash/resume keeps the FIX prompt intact. */
  private async persistFindings(run: WorkflowRun, taskId: string, stepRunId: string, findings: ReviewFinding[]): Promise<void> {
    this.artifacts.create({ id: randomUUID(), taskId, workflowRunId: run.id, stepRunId, kind: "review-findings", name: "review-findings", storage: { type: "INLINE", content: JSON.stringify(findings) }, createdAt: this.now() });
  }

  private async latestReviewFindings(run: WorkflowRun, taskId: string): Promise<ReviewFinding[]> {
    const artifacts = this.artifacts.listForTask(taskId).filter((a) => a.kind === "review-findings" && a.workflowRunId === run.id && a.storage.type === "INLINE");
    if (artifacts.length === 0) return [];
    const latest = artifacts[artifacts.length - 1]!;
    const storage = latest.storage as { type: "INLINE"; content: string };
    try { return JSON.parse(storage.content) as ReviewFinding[]; } catch { return []; }
  }

  /** Terminal transition that yields to a concurrent cancel: never overwrite CANCELLED. */
  private finishIfNotCancelled(runId: string, task: Task, state: "SUCCEEDED" | "FAILED"): WorkflowStatus {
    const current = this.requireRun(runId);
    if (current.state === "CANCELLED") return this.status(runId);
    this.workflows.updateRun(runId, { state, updatedAt: this.now() });
    this.tasks.update(task.id, { state }, this.now());
    return { run: this.requireRun(runId), steps: this.workflows.listSteps(runId), awaitingApproval: false };
  }

  approve(runId: string, approved: boolean): WorkflowStatus {
    this.requireResumable(runId);
    const gate = this.workflows.listSteps(runId).find((step) => step.stepType === "HUMAN_APPROVAL" && step.state === "QUEUED");
    if (!gate) throw new ValidationError(`WorkflowRun ${runId} has no pending approval gate`);
    const timestamp = this.now();
    if (approved) {
      this.workflows.updateStep(gate.id, { state: "SUCCEEDED", updatedAt: timestamp });
    } else {
      this.workflows.updateStep(gate.id, { state: "FAILED", updatedAt: timestamp });
      for (const step of this.workflows.listSteps(runId)) if (step.state === "QUEUED" || step.state === "RUNNING") this.workflows.updateStep(step.id, { state: "CANCELLED", updatedAt: timestamp });
      this.workflows.updateRun(runId, { state: "CANCELLED", updatedAt: timestamp });
      const { task } = this.contextForRun(runId);
      this.tasks.update(task.id, { state: "CANCELLED" }, timestamp);
    }
    return this.status(runId);
  }

  cancel(runId: string): WorkflowStatus {
    this.requireResumable(runId);
    const timestamp = this.now();
    for (const step of this.workflows.listSteps(runId)) if (step.state === "QUEUED" || step.state === "RUNNING") this.workflows.updateStep(step.id, { state: "CANCELLED", updatedAt: timestamp });
    this.workflows.updateRun(runId, { state: "CANCELLED", updatedAt: timestamp });
    const { task } = this.contextForRun(runId);
    if (task.state !== "SUCCEEDED" && task.state !== "FAILED") this.tasks.update(task.id, { state: "CANCELLED" }, timestamp);
    return this.status(runId);
  }

  status(runId: string): WorkflowStatus {
    const run = this.requireRun(runId);
    const steps = this.workflows.listSteps(runId);
    const awaitingApproval = !isTerminal(run.state) && steps.some((step) => step.stepType === "HUMAN_APPROVAL" && step.state === "QUEUED" && steps.slice(0, step.sequence).every((earlier) => earlier.state === "SUCCEEDED"));
    return { run, steps, awaitingApproval };
  }

  private async executeStep(runId: string, step: StepRun, task: Task, revision: TaskRevision, openFindings: ReviewFinding[], threads: Map<string, string>, stepTimeoutMs: number): Promise<{ state: "SUCCEEDED" | "FAILED" | "PAUSED"; paused?: boolean; review?: { findings: ReviewFinding[]; verdict: "PASS" | "NEEDS_FIXES" } }> {
    // Budget enforcement: a task past its caps fails fast instead of burning more agent time.
    const budget = this.budgetGuard(task.id);
    if (budget !== null && !budget.ok) {
      this.workflows.updateStep(step.id, { state: "FAILED", updatedAt: this.now() });
      return { state: "FAILED" };
    }
    this.workflows.updateStep(step.id, { state: "RUNNING", updatedAt: this.now() });
    if (step.stepType === "HUMAN_APPROVAL") {
      // External gate: park the step back at QUEUED and surface PAUSED to the caller.
      this.workflows.updateStep(step.id, { state: "QUEUED", updatedAt: this.now() });
      return { state: "PAUSED", paused: true };
    }
    if (step.stepType === "VERIFY") {
      const project = this.projects.findById(task.projectId);
      const command = project?.verifyCommand ?? null;
      const startedAt = this.now();
      const ok = command === null ? true : await this.verify(command, task, stepTimeoutMs);
      this.recordStepMetrics(step.id, startedAt);
      this.stepStateUnlessCancelled(runId, step.id, ok ? "SUCCEEDED" : "FAILED");
      return { state: ok ? "SUCCEEDED" : "FAILED" };
    }
    const policy: SessionPolicy = DEFAULT_SESSION_POLICIES[step.stepType] ?? "FRESH";
    const resumeThreadId = policy === "RESUME" ? threads.get(step.stepType) : undefined;
    const prompt = this.promptFor(step.stepType, revision, task, openFindings);
    const project = this.projects.findById(task.projectId);
    const startedAt = this.now();
    const execution = await this.runtime.run(
      { taskId: task.id, role: step.stepType, prompt, revisionRequest: revision.request, timeoutMs: stepTimeoutMs, permissionProfile: project?.permissionProfile ?? null },
      step.provider ?? "claude",
      resumeThreadId === undefined ? {} : { resumeThreadId },
    );
    if (policy === "RESUME") threads.set(step.stepType, execution.thread.id);
    this.recordStepMetrics(step.id, startedAt);
    if (this.usage !== null) this.usage({ taskId: task.id, provider: step.provider ?? "unknown", role: step.stepType, durationMs: Date.parse(this.now()) - Date.parse(startedAt) });
    const ok = execution.failure === null;
    this.stepStateUnlessCancelled(runId, step.id, ok ? "SUCCEEDED" : "FAILED");
    const review = step.stepType === "REVIEW" || step.stepType === "FINAL_REVIEW"
      ? parseReviewReport(execution.outcome?.stdout ?? "")
      : undefined;
    if (review === undefined) return { state: ok ? "SUCCEEDED" : "FAILED" };
    return { state: ok ? "SUCCEEDED" : "FAILED", review: { findings: review.findings, verdict: review.verdict } };
  }

  private recordStepMetrics(stepRunId: string, startedAtIso: string): void {
    if (this.metrics === null) return;
    this.metrics.recordStepDuration(stepRunId, Math.max(0, Date.parse(this.now()) - Date.parse(startedAtIso)));
  }

  /** A concurrent cancel() may have marked this step CANCELLED mid-flight; never overwrite that. */
  private stepStateUnlessCancelled(runId: string, stepId: string, state: "SUCCEEDED" | "FAILED"): void {
    if (this.requireRun(runId).state === "CANCELLED") return;
    this.workflows.updateStep(stepId, { state, updatedAt: this.now() });
  }

  private async verify(command: string[], task: Task, stepTimeoutMs: number): Promise<boolean> {
    if (!task.worktreePath) return false;
    const result = await this.verifyRunner.run({
      cwd: task.worktreePath,
      argv: command,
      env: agentEnvironment(this.baseEnv),
      timeoutMs: stepTimeoutMs,
    }).catch(() => null);
    return result !== null && result.exitCode === 0;
  }

  private promptFor(stepType: StepRun["stepType"], revision: TaskRevision, task: Task, openFindings: ReviewFinding[]): string {
    const base = `Task request: ${revision.request}\nWorking directory: ${task.worktreePath}`;
    switch (stepType) {
      case "PLAN": return `${base}\n\nProduce an implementation plan for this task. Do not modify any files.`;
      case "IMPLEMENT": return `${base}\n\nImplement the task request. Keep changes minimal. Do not commit; AgentDock tracks the diff.`;
      case "REVIEW":
      case "FINAL_REVIEW":
        return `${base}\n\nReview the current uncommitted diff. Report each issue on its own line as: FINDING [BLOCKER|MAJOR|MINOR|NIT] file:line summary\nEnd with exactly one line: VERDICT: PASS or VERDICT: NEEDS_FIXES. Do not modify files.`;
      case "FIX": {
        const externalFix = this.fixInstructions(task.id);
        const sections = [
          openFindings.length > 0 ? `Open findings from the latest review:\n${renderFindings(openFindings)}` : null,
          externalFix !== null ? `External fix requirements (CI/review):\n${externalFix}` : null,
        ].filter((section): section is string => section !== null);
        return `${base}${sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""}\n\nFix the reported issues in the current diff.`;
      }
      default: return base;
    }
  }


  private requireRun(runId: string): WorkflowRun {
    const run = this.workflows.findRun(runId);
    if (!run) throw new NotFoundError(`WorkflowRun ${runId} not found`);
    return run;
  }

  private requireResumable(runId: string): WorkflowRun {
    const run = this.requireRun(runId);
    if (isTerminal(run.state)) throw new ValidationError(`WorkflowRun ${runId} already finished (${run.state})`);
    return run;
  }

  /** Runs are pinned to their revision: resolve revision by id, then its task. */
  private contextForRun(runId: string): { task: Task; revision: TaskRevision } {
    const run = this.requireRun(runId);
    const revision = this.tasks.findRevisionById(run.taskRevisionId);
    if (!revision) throw new NotFoundError(`TaskRevision ${run.taskRevisionId} not found`);
    const task = this.tasks.findById(revision.taskId);
    if (!task) throw new NotFoundError(`Task ${revision.taskId} for revision ${revision.id} not found`);
    return { task, revision };
  }
}

function isTerminal(state: RunState): boolean { return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED"; }
