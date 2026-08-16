import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(readonly operation: string, readonly stderr: string) { super(`git ${operation} failed: ${stderr.trim() || "unknown error"}`); this.name = "GitError"; }
}

export interface WorktreeEntry { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean }

export class GitService {
  constructor(private readonly binary = "git") {}

  private async run(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, { cwd, shell: false, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
      throw new GitError(args[0] ?? "", stderr);
    }
  }

  async isWorkTree(cwd: string): Promise<boolean> {
    try { return (await this.run(["rev-parse", "--is-inside-work-tree"], cwd)).trim() === "true"; }
    catch { return false; }
  }

  async headSha(cwd: string): Promise<string> { return (await this.run(["rev-parse", "HEAD"], cwd)).trim(); }

  async branchExists(branch: string, cwd: string): Promise<boolean> {
    try { await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd); return true; }
    catch { return false; }
  }

  async worktreeAdd(path: string, branch: string, cwd: string, startRef?: string): Promise<void> {
    const args = startRef === undefined ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, startRef];
    await this.run(args, cwd);
  }

  async worktreeRemove(path: string, cwd: string, force = false): Promise<void> {
    await this.run(["worktree", "remove", ...(force ? ["--force"] : []), path], cwd);
  }

  async worktreePrune(cwd: string): Promise<void> { await this.run(["worktree", "prune"], cwd); }

  async worktreeList(cwd: string): Promise<WorktreeEntry[]> {
    const output = await this.run(["worktree", "list", "--porcelain"], cwd);
    return output.split("\n\n").map((block) => block.trim()).filter(Boolean).map((block) => {
      const entry: WorktreeEntry = { path: "", head: null, branch: null, bare: false, detached: false };
      for (const line of block.split("\n")) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") entry.path = value;
        else if (key === "HEAD") entry.head = value;
        else if (key === "branch") entry.branch = value;
        else if (key === "bare") entry.bare = true;
        else if (key === "detached") entry.detached = true;
      }
      return entry;
    }).filter((entry) => entry.path !== "");
  }

  // Always force-deletes: merge safety is decided by the caller against the configured base branch,
  // because `git branch -d` judges against the current HEAD, which may be checked out anywhere.
  async deleteBranch(branch: string, cwd: string): Promise<void> { await this.run(["branch", "-D", branch], cwd); }

  async statusEntries(cwd: string): Promise<{ status: string; path: string }[]> {
    const output = await this.run(["status", "--porcelain=v1", "-z"], cwd);
    const parts = output.split("\0");
    const entries: { status: string; path: string }[] = [];
    for (let index = 0; index < parts.length; index++) {
      const record = parts[index]!; if (record === "") continue;
      const status = record.slice(0, 2); const path = record.slice(3);
      if (status.startsWith("R") || status.startsWith("C")) index++; // rename/copy records carry a second NUL-separated original path
      entries.push({ status, path });
    }
    return entries;
  }

  async revListCount(fromRef: string, toRef: string, cwd: string): Promise<number> {
    return Number((await this.run(["rev-list", "--count", `${fromRef}..${toRef}`], cwd)).trim());
  }

  async mergeBase(ref: string, cwd: string): Promise<string> { return (await this.run(["merge-base", ref, "HEAD"], cwd)).trim(); }

  async diff(baseSha: string, cwd: string, stat = false): Promise<string> {
    return (await this.run(["diff", ...(stat ? ["--stat"] : []), baseSha], cwd)).trimEnd();
  }
}
