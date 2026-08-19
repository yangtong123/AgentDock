/** API response shapes mirrored from the gateway. */

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  worktreeRoot: string;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  maxConcurrentTasks: number;
  /** Project policy: agent sandboxing profile for every run. */
  permissionProfile: string | null;
}

export interface PresetsResponse {
  presets: { name: string; steps: { stepType: string; provider: string | null }[] }[];
  defaultProviders: Record<string, string>;
}

export interface LatestRun {
  id: string;
  state: string;
  preset: string | null;
  awaitingApproval: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  state: string;
  currentRevision: number;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: LatestRun | null;
  hasReviewFindings?: boolean;
}

export interface TaskRevision {
  id: string;
  taskId: string;
  revision: number;
  request: string;
  createdAt: string;
}

export interface WorkflowRun {
  id: string;
  taskRevisionId: string;
  preset: string | null;
  state: string;
  maxReviewRounds: number;
  stepTimeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface StepRun {
  id: string;
  workflowRunId: string;
  stepType: string;
  state: string;
  provider: string | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  durationMs?: number | null;
  reviewRound?: number | null;
}

export interface RunStatus {
  run: WorkflowRun;
  steps: StepRun[];
  awaitingApproval: boolean;
}

export interface TaskDetails {
  task: Task;
  currentRevision: TaskRevision;
  revisions: TaskRevision[];
  runs: RunStatus[];
}

export type ArtifactStorage = { type: "INLINE"; content: string } | { type: "FILE"; path: string };

export interface Artifact {
  id: string;
  taskId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  kind: string;
  name: string;
  storage: ArtifactStorage;
  createdAt: string;
}

export interface ActivityEvent {
  id: number;
  type: string;
  taskId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  actor: string | null;
  /** JSON string from the REST endpoint, parsed object from SSE. */
  payload: unknown;
  createdAt: string;
}

export interface LogChunk {
  offset: number;
  nextOffset: number;
  data: string;
  complete: boolean;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ReviewFinding {
  severity: "BLOCKER" | "MAJOR" | "MINOR" | "NIT";
  file: string | null;
  line: number | null;
  summary: string;
}
