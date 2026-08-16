import { randomUUID } from "node:crypto";
import type { RunState, StepRun, Task, TaskRevision, WorkflowRun } from "../shared/domain.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import type { WorkflowRepository } from "./workflow-repository.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import type { AgentThreadManager } from "../runtime/agent-thread-manager.js";
import { expandPreset, type ProviderAssignment } from "./presets.js";
import { ProcessRunner } from "../runtime/process-runner.js";
import { agentEnvironment } from "../runtime/env-agents.js";

export interface StartWorkflowInput {
  taskId: string;
  preset: string;
  providers?: ProviderAssignment;
  stepTimeoutMs?: number;
}

export interface WorkflowStatus {
  run: WorkflowRun;
  steps: StepRun[];
  /** Set when execute() returned because a HUMAN_APPROVAL gate is pending. */
  awaitingApproval: boolean;
}

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;

type StepOutcome = "SUCCEEDED" | "FAILED" | "PAUSED";

/**
 * The orchestrator owns workflow state, retries, approvals, and cancellation.
 * execute() advances one run through its step sequence until it finishes or
 * pauses at a HUMAN_APPROVAL gate; approve()/reject() releases the gate.
 * Runs are pinned to the task revision captured at start(), so revising a
 * task mid-run never retargets an in-flight workflow. VERIFY runs the
 * project's deterministic verify command — higher authority than LLM review.
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

    this.workflows.updateRun(runId, { state: "RUNNING", updatedAt: this.now() });
    let previousReviewFindings: string | null = null;
    for (const step of this.workflows.listSteps(runId)) {
      // Re-check run state every iteration: a concurrent cancel()/approve() must win.
      if (this.requireRun(runId).state === "CANCELLED") return this.status(runId);
      if (step.state === "SUCCEEDED") continue;
      if (step.state === "CANCELLED") return this.status(runId);
      // A step left RUNNING by a previous crash is safe to re-run: agent steps resume their threads.

      const outcome = await this.executeStep(runId, step, task, revision, previousReviewFindings, stepTimeoutMs);
      if (outcome.paused) return { run: this.requireRun(runId), steps: this.workflows.listSteps(runId), awaitingApproval: true };
      if (outcome.state === "SUCCEEDED" && step.stepType === "REVIEW") previousReviewFindings = outcome.reviewFindings ?? previousReviewFindings;
      if (outcome.state === "FAILED") return this.finishIfNotCancelled(runId, task, "FAILED");
    }
    return this.finishIfNotCancelled(runId, task, "SUCCEEDED");
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
    const run = this.requireResumable(runId);
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
    void run;
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

  private async executeStep(runId: string, step: StepRun, task: Task, revision: TaskRevision, reviewFindings: string | null, stepTimeoutMs: number): Promise<{ state: StepOutcome; paused?: boolean; reviewFindings?: string | null }> {
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
    const prompt = this.promptFor(step.stepType, revision, task, reviewFindings);
    const execution = await this.runtime.run(
      { taskId: task.id, role: step.stepType, prompt, revisionRequest: revision.request, timeoutMs: stepTimeoutMs },
      step.provider ?? "claude",
    );
    const ok = execution.failure === null;
    this.stepStateUnlessCancelled(runId, step.id, ok ? "SUCCEEDED" : "FAILED");
    const findings: string | null = execution.outcome?.stdout ?? null;
    return { state: ok ? "SUCCEEDED" : "FAILED", reviewFindings: findings };
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

  private promptFor(stepType: StepRun["stepType"], revision: TaskRevision, task: Task, reviewFindings: string | null): string {
    const base = `Task request: ${revision.request}\nWorking directory: ${task.worktreePath}`;
    switch (stepType) {
      case "PLAN": return `${base}\n\nProduce an implementation plan for this task. Do not modify any files.`;
      case "IMPLEMENT": return `${base}\n\nImplement the task request. Keep changes minimal. Do not commit; AgentDock tracks the diff.`;
      case "REVIEW": return `${base}\n\nReview the current uncommitted diff for correctness, security, and clarity. Report findings only; do not modify files.`;
      case "FIX": return `${base}${reviewFindings ? `\n\nFindings from the previous review:\n${reviewFindings}` : ""}\n\nFix the issues reported by the previous review of the current diff.`;
      case "FINAL_REVIEW": return `${base}\n\nPerform a final review of the diff. Give a verdict and remaining risks. Do not modify files.`;
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
