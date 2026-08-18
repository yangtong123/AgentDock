import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckRun, CiStatus, CreateDraftPrInput, GitHubPort, PrReview, PullRequest } from "./github-port.js";

const execFileAsync = promisify(execFile);

type GhPr = {
  number: number; url: string; state: string; isDraft: boolean; title: string; headRefName: string;
};

/** gh pr checks --json fields: name, state (e.g. "pass"/"fail"/"pending"), bucket. */
type GhCheckRun = { name: string; state: string; bucket: string };

type GhReview = { id?: number | string; author: { login: string } | null; state: string; body: string | null };

const STATE_TO_STATUS: Record<string, CheckRun["status"]> = {
  pass: "COMPLETED", fail: "COMPLETED", skipping: "COMPLETED", canceled: "COMPLETED",
  pending: "IN_PROGRESS",
};

/**
 * GitHub adapter over the `gh` CLI for PR operations and `git push` for
 * branch delivery. Every argument is an argv element — branch names and
 * titles from task context never touch a shell. The token lives in gh's own
 * auth store; AgentDock never handles it.
 */
export class GhCliAdapter implements GitHubPort {
  constructor(private readonly binary = "gh", private readonly gitBinary = "git") {}

  private async run(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(this.binary, args, { cwd, shell: false, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /** `gh push` does not exist: branch delivery goes through git itself. */
  async pushBranch(repoPath: string, headBranch: string): Promise<void> {
    await execFileAsync(this.gitBinary, ["push", "-u", "origin", headBranch], { cwd: repoPath, shell: false });
  }

  async commitAll(repoPath: string, message: string): Promise<boolean> {
    await execFileAsync(this.gitBinary, ["add", "-A"], { cwd: repoPath, shell: false });
    const { stdout } = await execFileAsync(this.gitBinary, ["status", "--porcelain"], { cwd: repoPath, shell: false });
    if (stdout.trim() === "") return false;
    // Explicit identity: automation-authored commits stay visible as such and
    // never depend on the host's git config.
    await execFileAsync(this.gitBinary, ["-c", "user.name=agentdock", "-c", "user.email=agentdock@localhost", "commit", "-m", message], { cwd: repoPath, shell: false });
    return true;
  }

  async createDraftPr(repoPath: string, input: CreateDraftPrInput): Promise<PullRequest> {
    const output = await this.run(["pr", "create", "--draft", "--title", input.title, "--body", input.body, "--head", input.headBranch, "--base", input.baseBranch], repoPath);
    const number = Number(output.trim().match(/\/pull\/(\d+)/)?.[1] ?? 0);
    if (number === 0) throw new Error(`could not parse PR number from gh output: ${output.trim()}`);
    const json = await this.run(["pr", "view", String(number), "--json", "number,url,state,isDraft,title,headRefName"], repoPath);
    return this.mapPr(JSON.parse(json) as GhPr);
  }

  /** --state all: a closed/merged PR must still be visible, not silently null. */
  async findPrForBranch(repoPath: string, headBranch: string): Promise<PullRequest | null> {
    const json = await this.run(["pr", "list", "--state", "all", "--head", headBranch, "--json", "number,url,state,isDraft,title,headRefName", "--limit", "1"], repoPath);
    const rows = JSON.parse(json) as GhPr[];
    return rows.length === 0 ? null : this.mapPr(rows[0]!);
  }

  async ciStatus(repoPath: string, prNumber: number): Promise<CiStatus> {
    // gh pr checks exits 8 while pending and 1 when failing — both carry JSON data on stdout.
    let json: string;
    try {
      json = await this.run(["pr", "checks", String(prNumber), "--json", "name,state,bucket", "--watch=false"], repoPath);
    } catch (error) {
      const err = error as { code?: number | string; stdout?: string };
      const code = typeof err.code === "string" ? Number(err.code) : err.code;
      if ((code === 1 || code === 8) && typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) json = err.stdout;
      else throw error;
    }
    const rows = JSON.parse(json) as GhCheckRun[];
    const checkRuns: CheckRun[] = rows.map((row) => ({
      name: row.name,
      status: STATE_TO_STATUS[row.state] ?? "UNKNOWN",
      conclusion: row.state === "pass" ? "SUCCESS" : row.state === "fail" ? "FAILURE" : null,
    }));
    const aggregate = checkRuns.some((run) => run.status !== "COMPLETED")
      ? "PENDING"
      : checkRuns.some((run) => run.conclusion === "FAILURE")
        ? "FAILING"
        : "PASSING";
    return { checkRuns, aggregate };
  }

  async reviews(repoPath: string, prNumber: number): Promise<PrReview[]> {
    const json = await this.run(["pr", "view", String(prNumber), "--json", "reviews"], repoPath);
    const parsed = JSON.parse(json) as { reviews: GhReview[] | null };
    return (parsed.reviews ?? []).map((review) => ({
      id: review.id === undefined ? null : String(review.id),
      author: review.author?.login ?? "unknown",
      state: review.state,
      body: review.body ?? "",
    }));
  }

  private mapPr(pr: GhPr): PullRequest {
    const state = pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED" ? pr.state : "UNKNOWN";
    return { number: pr.number, url: pr.url, state, isDraft: pr.isDraft, title: pr.title, headRefName: pr.headRefName };
  }
}
