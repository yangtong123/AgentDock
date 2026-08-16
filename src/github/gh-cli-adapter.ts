import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckRun, CiStatus, CreateDraftPrInput, GitHubPort, PrReview, PullRequest } from "./github-port.js";

const execFileAsync = promisify(execFile);

type GhPr = {
  number: number; url: string; state: string; isDraft: boolean; title: string; headRefName: string;
};

type GhCheckRun = { name: string; status: string; conclusion: string | null };

type GhReview = { author: { login: string } | null; state: string; body: string | null };

/**
 * GitHub adapter over the `gh` CLI. Every argument is an argv element —
 * branch names and titles from task context never touch a shell. The token
 * lives in gh's own auth store; AgentDock never handles it.
 */
export class GhCliAdapter implements GitHubPort {
  constructor(private readonly binary = "gh") {}

  private async run(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(this.binary, args, { cwd, shell: false, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  async pushBranch(repoPath: string, headBranch: string): Promise<void> {
    await this.run(["push", "-u", "origin", headBranch], repoPath);
  }

  async createDraftPr(repoPath: string, input: CreateDraftPrInput): Promise<PullRequest> {
    const output = await this.run(["pr", "create", "--draft", "--title", input.title, "--body", input.body, "--head", input.headBranch, "--base", input.baseBranch], repoPath);
    // gh prints the PR URL; use it to fetch structured state.
    const number = Number(output.trim().match(/\/pull\/(\d+)/)?.[1] ?? 0);
    if (number === 0) throw new Error(`could not parse PR number from gh output: ${output.trim()}`);
    const json = await this.run(["pr", "view", String(number), "--json", "number,url,state,isDraft,title,headRefName"], repoPath);
    return this.mapPr(JSON.parse(json) as GhPr);
  }

  async findPrForBranch(repoPath: string, headBranch: string): Promise<PullRequest | null> {
    const json = await this.run(["pr", "list", "--head", headBranch, "--json", "number,url,state,isDraft,title,headRefName", "--limit", "1"], repoPath);
    const rows = JSON.parse(json) as GhPr[];
    return rows.length === 0 ? null : this.mapPr(rows[0]!);
  }

  async ciStatus(repoPath: string, prNumber: number): Promise<CiStatus> {
    const json = await this.run(["pr", "checks", String(prNumber), "--json", "name,status,conclusion"], repoPath);
    const rows = JSON.parse(json) as GhCheckRun[];
    const checkRuns: CheckRun[] = rows.map((row) => ({
      name: row.name,
      status: row.status === "QUEUED" || row.status === "IN_PROGRESS" || row.status === "COMPLETED" ? row.status : "UNKNOWN",
      conclusion: row.conclusion ?? null,
    }));
    const aggregate = checkRuns.some((run) => run.status !== "COMPLETED")
      ? "PENDING"
      : checkRuns.some((run) => run.conclusion !== null && run.conclusion !== "SUCCESS" && run.conclusion !== "SKIPPED" && run.conclusion !== "NEUTRAL")
        ? "FAILING"
        : "PASSING";
    return { checkRuns, aggregate };
  }

  async reviews(repoPath: string, prNumber: number): Promise<PrReview[]> {
    const json = await this.run(["pr", "view", String(prNumber), "--json", "reviews"], repoPath);
    const parsed = JSON.parse(json) as { reviews: GhReview[] | null };
    return (parsed.reviews ?? []).map((review) => ({ author: review.author?.login ?? "unknown", state: review.state, body: review.body ?? "" }));
  }

  private mapPr(pr: GhPr): PullRequest {
    const state = pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED" ? pr.state : "UNKNOWN";
    return { number: pr.number, url: pr.url, state, isDraft: pr.isDraft, title: pr.title, headRefName: pr.headRefName };
  }
}
