import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { GitHubService } from "../src/github/github-service.js";
import { GhCliAdapter } from "../src/github/gh-cli-adapter.js";
import type { CiStatus, CreateDraftPrInput, GitHubPort, PrReview, PullRequest } from "../src/github/github-port.js";

function fakeGithub(behavior: { prNumber?: number; ciAggregate?: CiStatus["aggregate"]; reviews?: PrReview[] } = {}): GitHubPort & { pushes: { repoPath: string; branch: string }[]; createdPrs: CreateDraftPrInput[] } {
  const pushes: { repoPath: string; branch: string }[] = [];
  const createdPrs: CreateDraftPrInput[] = [];
  return {
    pushes, createdPrs,
    async pushBranch(repoPath, branch) { pushes.push({ repoPath, branch }); },
    async createDraftPr(repoPath, input) { createdPrs.push(input); return { number: behavior.prNumber ?? 42, url: `https://example/pull/${behavior.prNumber ?? 42}`, state: "OPEN", isDraft: true, title: input.title, headRefName: input.headBranch }; },
    async findPrForBranch() { return { number: behavior.prNumber ?? 42, url: "https://example/pull/42", state: "OPEN", isDraft: false, title: "t", headRefName: "h" }; },
    async ciStatus(): Promise<CiStatus> {
      if (behavior.ciAggregate === "FAILING") return { aggregate: "FAILING", checkRuns: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] };
      if (behavior.ciAggregate === "PENDING") return { aggregate: "PENDING", checkRuns: [{ name: "build", status: "IN_PROGRESS", conclusion: null }] };
      return { aggregate: "PASSING", checkRuns: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] };
    },
    async reviews() { return behavior.reviews ?? []; },
  };
}

interface Fixture {
  base: string;
  db: ReturnType<typeof openDatabase>;
  app: ReturnType<typeof createApplication>;
  github: ReturnType<typeof fakeGithub>;
  service: GitHubService;
}

async function succeededTask(f: Fixture): Promise<string> {
  const project = f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
  const { task } = f.app.tasks.create(project.id, "feature request");
  const prepared = await f.app.worktrees.prepare(task.id);
  writeFileSync(join(prepared.worktreePath!, "feature.txt"), "done\n");
  f.app.repositories.tasks.update(task.id, { state: "SUCCEEDED" }, new Date().toISOString());
  return task.id;
}

function fixture(behavior: Parameters<typeof fakeGithub>[0] = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "agentdock-gh-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const github = fakeGithub(behavior);
  const service = new GitHubService(db, github, app.repositories.tasks, app.repositories.projects);
  return { base, db, app, github, service };
}

test("createDraftPr pushes the branch and records the draft PR", async () => {
  const f = fixture();
  try {
    const taskId = await succeededTask(f);
    const record = await f.service.createDraftPr({ taskId, title: "Add feature" });
    assert.equal(record.prNumber, 42);
    assert.equal(record.isDraft, true);
    assert.equal(f.github.pushes.length, 1);
    assert.equal(f.github.pushes[0]!.branch.startsWith("agentdock/"), true);
    assert.equal(f.github.createdPrs[0]!.title, "Add feature");
    assert.equal(f.service.recordFor(taskId)!.prUrl, "https://example/pull/42");
    // Duplicate PR is refused.
    await assert.rejects(f.service.createDraftPr({ taskId, title: "again" }), /already has PR/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("createDraftPr refuses non-succeeded tasks", async () => {
  const f = fixture();
  try {
    const project = f.app.projects.create({ name: "p", repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
    const { task } = f.app.tasks.create(project.id, "draft work");
    await f.app.worktrees.prepare(task.id);
    await assert.rejects(f.service.createDraftPr({ taskId: task.id, title: "t" }), /only SUCCEEDED/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("CI failure ingestion marks the task failed and records a fix trigger", async () => {
  const f = fixture({ ciAggregate: "FAILING" });
  try {
    const taskId = await succeededTask(f);
    await f.service.createDraftPr({ taskId, title: "t" });
    const refreshed = await f.service.refresh(taskId);
    assert.equal(refreshed.ciAggregate, "FAILING");
    assert.deepEqual(refreshed.failedChecks, ["build"]);
    assert.equal(refreshed.fixTriggered, true);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "FAILED");
    const triggers = f.service.pendingFixTriggers(taskId);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0]!.reason, "CI_FAILURE");
    assert.match(triggers[0]!.detail, /build/);
    // A second refresh does not re-trigger (task already FAILED).
    const again = await f.service.refresh(taskId);
    assert.equal(again.fixTriggered, false);
    assert.equal(f.service.pendingFixTriggers(taskId).length, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("passing CI does not trigger a fix", async () => {
  const f = fixture({ ciAggregate: "PASSING" });
  try {
    const taskId = await succeededTask(f);
    await f.service.createDraftPr({ taskId, title: "t" });
    const refreshed = await f.service.refresh(taskId);
    assert.equal(refreshed.fixTriggered, false);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("PR review ingestion: CHANGES_REQUESTED triggers a fix once; repeats deduplicated", async () => {
  const review = { id: "r1", author: "alice", state: "CHANGES_REQUESTED", body: "please handle nulls" };
  const f = fixture({ reviews: [review] });
  try {
    const taskId = await succeededTask(f);
    await f.service.createDraftPr({ taskId, title: "t" });
    const first = await f.service.ingestReviews(taskId);
    assert.equal(first.newReviews.length, 1);
    assert.equal(first.fixTriggered, true);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "FAILED");
    const second = await f.service.ingestReviews(taskId);
    assert.equal(second.newReviews.length, 0, "same review is not re-ingested");
    assert.equal(second.fixTriggered, false);
    assert.equal(f.service.pendingFixTriggers(taskId)[0]!.reason, "PR_REVIEW");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("GhCliAdapter builds argv-only gh/git invocations (no shell)", async () => {
  const calls: string[][] = [];
  const gitCalls: string[][] = [];
  const adapter = new GhCliAdapter("echo-gh", "echo-git");
  const recording = adapter as unknown as { run(args: string[], cwd: string): Promise<string> };
  (adapter as unknown as Record<string, unknown>).run = async (args: string[], _cwd: string) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "create") return "https://example/pull/9\n";
    if (args[0] === "pr" && args[1] === "checks") return "[]";
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 9, url: "https://example/pull/9", state: "OPEN", isDraft: true, title: "t", headRefName: "h" });
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, url: "https://example/pull/9", state: "OPEN", isDraft: true, title: "t", headRefName: "h" }]);
    return "{}";
  };
  // pushBranch goes through git (gh has no push): run against an existing cwd so the no-op binary resolves.
  const noopAdapter = new GhCliAdapter("echo-gh", "true");
  await noopAdapter.pushBranch(process.cwd(), "agentdock/t1");
  void gitCalls;
  await adapter.createDraftPr("/repo", { title: "t; rm -rf /", body: "b", headBranch: "agentdock/t1", baseBranch: "main" });
  const create = calls.find((args) => args[0] === "pr" && args[1] === "create")!;
  assert.equal(create.includes("--draft"), true);
  // The dangerous title is a single argv element, never shell-interpreted.
  assert.equal(create[create.indexOf("--title") + 1], "t; rm -rf /");
  void recording;
  await adapter.ciStatus("/repo", 7);
  assert.deepEqual(calls.at(-1)!.slice(0, 3), ["pr", "checks", "7"]);
  await adapter.findPrForBranch("/repo", "agentdock/t1");
  const list = calls.find((args) => args[0] === "pr" && args[1] === "list")!;
  assert.equal(list.includes("--state"), true);
  assert.equal(list[list.indexOf("--state") + 1], "all");
});
