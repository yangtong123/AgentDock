import type { Database } from "../db/database.js";
import type { GitHubPort, PrReview, PullRequest } from "./github-port.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";

export interface PrRecord {
  id: string;
  taskId: string;
  prNumber: number;
  prUrl: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrCreationInput { taskId: string; title: string; body?: string }

/**
 * Connects finished tasks to GitHub delivery: push the task branch, open a
 * Draft PR (never auto-merge), and poll CI/review state into durable
 * records so FIX workflows can react to failures and review feedback.
 */
export class GitHubService {
  constructor(
    private readonly db: Database,
    private readonly github: GitHubPort,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly now = () => new Date().toISOString(),
  ) {
  }

  /** Commits nothing: AgentDock pushes the task branch as-is and opens a Draft PR. */
  async createDraftPr(input: PrCreationInput): Promise<PrRecord> {
    const task = this.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (!task.branch || !task.worktreePath) throw new ValidationError(`Task ${input.taskId} has no branch/worktree`);
    if (task.state !== "SUCCEEDED") throw new ValidationError(`Task ${input.taskId} is ${task.state}; only SUCCEEDED tasks open PRs`);
    const existing = this.recordFor(task.id);
    if (existing) throw new ValidationError(`Task ${input.taskId} already has PR #${existing.prNumber}`);

    const project = this.projects.findById(task.projectId);
    if (!project) throw new NotFoundError(`Project ${task.projectId} not found`);
    // Push from the task worktree: the worktree's branch is the head.
    await this.github.pushBranch(task.worktreePath, task.branch);
    const pr = await this.github.createDraftPr(project.repoPath, {
      title: input.title,
      body: input.body ?? `AgentDock task ${task.id}`,
      headBranch: task.branch,
      baseBranch: project.baseBranch,
    });
    const timestamp = this.now();
    const record: PrRecord = { id: crypto.randomUUID(), taskId: task.id, prNumber: pr.number, prUrl: pr.url, headBranch: task.branch, baseBranch: project.baseBranch, state: pr.state, isDraft: pr.isDraft, createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare("INSERT INTO pull_requests (id,task_id,pr_number,pr_url,head_branch,base_branch,state,is_draft,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(record.id, record.taskId, record.prNumber, record.prUrl, record.headBranch, record.baseBranch, record.state, record.isDraft ? 1 : 0, record.createdAt, record.updatedAt);
    return record;
  }

  recordFor(taskId: string): PrRecord | null {
    const row = this.db.prepare("SELECT * FROM pull_requests WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.map(row);
  }

  /** Refreshes PR + CI state; returns the fix-workflow trigger when CI fails. */
  async refresh(taskId: string): Promise<{ pr: PrRecord; ciAggregate: "PENDING" | "PASSING" | "FAILING"; failedChecks: string[]; fixTriggered: boolean }> {
    const record = this.recordFor(taskId);
    if (!record) throw new NotFoundError(`Task ${taskId} has no PR`);
    const task = this.tasks.findById(taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    const project = this.projects.findById(task.projectId);
    if (!project) throw new NotFoundError(`Project ${task.projectId} not found`);

    const pr = await this.github.findPrForBranch(project.repoPath, record.headBranch);
    const ci = await this.github.ciStatus(project.repoPath, record.prNumber);
    const timestamp = this.now();
    if (pr) this.db.prepare("UPDATE pull_requests SET state = ?, is_draft = ?, updated_at = ? WHERE task_id = ?").run(pr.state, pr.isDraft ? 1 : 0, timestamp, taskId);

    const failedChecks = ci.checkRuns.filter((run) => run.status === "COMPLETED" && run.conclusion !== null && run.conclusion !== "SUCCESS" && run.conclusion !== "SKIPPED" && run.conclusion !== "NEUTRAL").map((run) => run.name);
    // CI failure ingestion: a failed check on a SUCCEEDED task marks it for a FIX workflow.
    const fixTriggered = ci.aggregate === "FAILING" && task.state === "SUCCEEDED";
    if (fixTriggered) {
      this.tasks.update(taskId, { state: "FAILED" }, timestamp);
      this.db.prepare(`INSERT INTO github_fix_events (id, task_id, pr_number, reason, detail, created_at) VALUES (?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), taskId, record.prNumber, "CI_FAILURE", JSON.stringify(failedChecks), timestamp);
    }
    return { pr: this.recordFor(taskId)!, ciAggregate: ci.aggregate, failedChecks, fixTriggered };
  }

  /** PR review feedback ingestion: human review comments become fix instructions. */
  async ingestReviews(taskId: string): Promise<{ newReviews: { author: string; state: string; body: string }[]; fixTriggered: boolean }> {
    const record = this.recordFor(taskId);
    if (!record) throw new NotFoundError(`Task ${taskId} has no PR`);
    const task = this.tasks.findById(taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    const project = this.projects.findById(task.projectId);
    if (!project) throw new NotFoundError(`Project ${task.projectId} not found`);

    const all = await this.github.reviews(project.repoPath, record.prNumber);
    const fresh: PrReview[] = [];
    for (const review of all) {
      const key = `${record.prNumber}:${review.author}:${review.state}:${review.body.length}`;
      const seen = this.db.prepare("SELECT 1 FROM github_review_ingested WHERE review_key = ?").get(key);
      if (seen === undefined) {
        fresh.push(review);
        this.db.prepare("INSERT INTO github_review_ingested (review_key, task_id, created_at) VALUES (?,?,?)").run(key, taskId, this.now());
      }
    }
    // CHANGES_REQUESTED reviews on a SUCCEEDED task trigger a FIX workflow.
    const fixTriggered = fresh.some((review) => review.state === "CHANGES_REQUESTED") && task.state === "SUCCEEDED";
    if (fixTriggered) {
      const timestamp = this.now();
      this.tasks.update(taskId, { state: "FAILED" }, timestamp);
      this.db.prepare(`INSERT INTO github_fix_events (id, task_id, pr_number, reason, detail, created_at) VALUES (?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), taskId, record.prNumber, "PR_REVIEW", JSON.stringify(fresh.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => ({ author: r.author, body: r.body.slice(0, 2000) }))), timestamp);
    }
    return { newReviews: fresh.map(({ author, state, body }) => ({ author, state, body })), fixTriggered };
  }

  /** Pending fix triggers for a task (CI failures, review feedback). */
  pendingFixTriggers(taskId: string): { reason: string; detail: string }[] {
    return this.db.prepare("SELECT reason, detail FROM github_fix_events WHERE task_id = ? ORDER BY created_at").all(taskId) as { reason: string; detail: string }[];
  }

  private map(row: Record<string, unknown>): PrRecord {
    return {
      id: String(row.id), taskId: String(row.task_id), prNumber: Number(row.pr_number), prUrl: String(row.pr_url),
      headBranch: String(row.head_branch), baseBranch: String(row.base_branch), state: String(row.state),
      isDraft: Number(row.is_draft) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
