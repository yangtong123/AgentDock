import { randomUUID } from "node:crypto";
import type { RunState, StepRun, Task, TaskRevision, WorkflowRun } from "../shared/domain.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import type { WorkflowRepository } from "./workflow-repository.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { ProjectRepository } from "../projects/project-repository.js";
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
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly runtime: AgentThreadManager,
    private readonly verifyRunner: ProcessRunner,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly now = () => new Date().toISOString(),
  ) {}

  async start(input: StartWorkflowInput): Promise<WorkflowStatus> {
    const task = this.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (task.state !== "READY") throw new ValidationError(`Task ${input.taskId} is ${task.state}; workflows start from READY tasks`);
    const steps = expandPreset(input.preset, input.providers);
    const revision = this.tasks.findRevision(task.id, task.currentRevision);
    if (!revision) throw new NotFoundError(`Task ${task.id} revision ${task.currentRevision} not found`);
    validateMaxReviewRounds(input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS);

    const timestamp = this.now();
    const run: WorkflowRun = { id: randomUUID(), taskRevisionId: revision.id, preset: input.preset, state: "QUEUED", createdAt: timestamp, updatedAt: timestamp };
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
    const stepTimeoutMs = this.stepTimeoutMs();
    const maxRounds = DEFAULT_MAX_REVIEW_ROUNDS;

    this.workflows.updateRun(runId, { state: "RUNNING", updatedAt: this.now() });
    const threads = new Map<string, string>(); // role -> thread id, for RESUME session policy
    let reviewRound = 0;
    let openFindings: ReviewFinding[] = [];
    let reviewProvider: string | null = null;
    let fixProvider: string | null = null;
    while (true) {
      const steps = this.workflows.listSteps(runId);
      const next = steps.find((step) => step.state !== "SUCCEEDED" && step.state !== "CANCELLED");
      if (next === undefined) break;
      // Re-check run state each iteration: a concurrent cancel()/approve() must win.
      if (this.requireRun(runId).state === "CANCELLED") return this.status(runId);

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
        openFindings = outcome.review?.findings ?? [];
        if (openFindings.length > 0) {
          reviewRound++;
          if (reviewRound >= maxRounds) {
            // Bounded loop exhausted: fail instead of reviewing forever.
            this.workflows.updateStep(next.id, { state: "FAILED", updatedAt: this.now() });
            return this.finishIfNotCancelled(runId, task, "FAILED");
          }
          // Another round: append FIX -> VERIFY -> REVIEW before FINAL_REVIEW.
          this.appendLoopRound(runId, next, reviewProvider, fixProvider);
        }
      }
      if (next.stepType === "FIX") fixProvider = next.provider;
    }
    return this.finishIfNotCancelled(runId, task, "SUCCEEDED");
  }

  /** Dynamically appends one bounded FIX->VERIFY->REVIEW round after the anchor step. */
  private appendLoopRound(runId: string, anchor: StepRun, reviewProvider: string | null, fixProvider: string | null): void {
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
    // Rewrite every sequence at once via a temporary high range to dodge the UNIQUE constraint.
    const finalOrder = [...before, ...roundSteps, ...tails];
    for (const [index, step] of finalOrder.entries()) this.workflows.updateSequence(step.id, 1000 + index, timestamp);
    for (const [index, step] of finalOrder.entries()) this.workflows.updateSequence(step.id, index, timestamp);
    for (const step of roundSteps) {
      this.workflows.createStep({ id: step.id, workflowRunId: runId, stepType: step.stepType, state: "QUEUED", provider: step.provider, sequence: step.sequence, createdAt: timestamp, updatedAt: timestamp });
    }
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

  private async executeStep(runId: string, step: StepRun, task: Task, revision: TaskRevision, openFindings: ReviewFinding[], threads: Map<string, string>, stepTimeoutMs: number): Promise<{ state: "SUCCEEDED" | "FAILED" | "PAUSED"; paused?: boolean; review?: { findings: ReviewFinding[] } }> {
    this.workflows.updateStep(step.id, { state: "RUNNING", updatedAt: this.now() });
    if (step.stepType === "HUMAN_APPROVAL") {
      // External gate: park the step back at QUEUED and surface PAUSED to the caller.
      this.workflows.updateStep(step.id, { state: "QUEUED", updatedAt: this.now() });
      return { state: "PAUSED", paused: true };
    }
    if (step.stepType === "VERIFY") {
      const project = this.projects.findById(task.projectId);
      const command = project?.verifyCommand ?? null;
      const ok = command === null ? true : await this.verify(command, task, stepTimeoutMs);
      this.stepStateUnlessCancelled(runId, step.id, ok ? "SUCCEEDED" : "FAILED");
      return { state: ok ? "SUCCEEDED" : "FAILED" };
    }
    const policy: SessionPolicy = DEFAULT_SESSION_POLICIES[step.stepType] ?? "FRESH";
    const resumeThreadId = policy === "RESUME" ? threads.get(step.stepType) : undefined;
    const prompt = this.promptFor(step.stepType, revision, task, openFindings);
    const execution = await this.runtime.run(
      { taskId: task.id, role: step.stepType, prompt, revisionRequest: revision.request, timeoutMs: stepTimeoutMs },
      step.provider ?? "claude",
      resumeThreadId === undefined ? {} : { resumeThreadId },
    );
    if (policy === "RESUME") threads.set(step.stepType, execution.thread.id);
    const ok = execution.failure === null;
    this.stepStateUnlessCancelled(runId, step.id, ok ? "SUCCEEDED" : "FAILED");
    const review = step.stepType === "REVIEW" || step.stepType === "FINAL_REVIEW"
      ? parseReviewReport(execution.outcome?.stdout ?? "")
      : undefined;
    if (review === undefined) return { state: ok ? "SUCCEEDED" : "FAILED" };
    return { state: ok ? "SUCCEEDED" : "FAILED", review: { findings: review.findings } };
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
      case "FIX": return `${base}${openFindings.length > 0 ? `\n\nOpen findings from the latest review:\n${renderFindings(openFindings)}` : ""}\n\nFix the reported issues in the current diff.`;
      default: return base;
    }
  }

  private stepTimeoutMs(): number { return DEFAULT_STEP_TIMEOUT_MS; }

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
