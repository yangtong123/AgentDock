export const PROJECT_STATUSES = ["ACTIVE", "PAUSED", "DISABLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATES = ["DRAFT", "READY", "RUNNING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const RUN_STATES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const STEP_TYPES = ["PLAN", "IMPLEMENT", "VERIFY", "REVIEW", "FIX", "FINAL_REVIEW", "HUMAN_APPROVAL"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export interface Project {
  id: string; name: string; repoPath: string; baseBranch: string; worktreeRoot: string;
  status: ProjectStatus; maxConcurrentTasks: number; defaultWorkflowPreset: string | null;
  /** Deterministic verification command, stored as a JSON argv array. */
  verifyCommand: string[] | null;
  /** Permission profile name controlling agent sandboxing (default/restricted/sandboxed). */
  permissionProfile: string | null;
  createdAt: string; updatedAt: string;
}
export interface Task {
  id: string; projectId: string; state: TaskState; currentRevision: number;
  branch: string | null; worktreePath: string | null; createdAt: string; updatedAt: string;
}
export interface TaskRevision { id: string; taskId: string; revision: number; request: string; createdAt: string; }
export interface TaskDetails { task: Task; currentRevision: TaskRevision; revisions: TaskRevision[]; }
export interface WorkflowRun { id: string; taskRevisionId: string; preset: string | null; state: RunState; maxReviewRounds: number; stepTimeoutMs: number; createdAt: string; updatedAt: string; }
export interface StepRun { id: string; workflowRunId: string; stepType: StepType; state: RunState; provider: string | null; sequence: number; createdAt: string; updatedAt: string; }
export interface AgentThread { id: string; taskId: string; provider: string; role: string; externalSessionId: string | null; createdAt: string; updatedAt: string; }
export type ArtifactStorage = { type: "INLINE"; content: string } | { type: "FILE"; path: string };
export interface Artifact { id: string; taskId: string; workflowRunId: string | null; stepRunId: string | null; kind: string; name: string; storage: ArtifactStorage; createdAt: string; }

export class NotFoundError extends Error {}
export class ValidationError extends Error {}
/** A ValidationError that means concurrent/stale state, not malformed input (409 semantics). */
export class StateConflictError extends ValidationError {}
