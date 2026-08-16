import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, type Database } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";

function git(args: string[], cwd: string): void { execFileSync("git", args, { cwd }); }
function gitOutput(args: string[], cwd: string): string { return execFileSync("git", args, { cwd }).toString(); }

function createRepository(directory: string): string {
  mkdirSync(directory, { recursive: true });
  git(["init"], directory);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], directory);
  git(["config", "user.email", "agentdock@test"], directory);
  git(["config", "user.name", "AgentDock Test"], directory);
  writeFileSync(join(directory, "README.md"), "# fixture\n");
  git(["add", "."], directory);
  git(["commit", "-m", "initial commit"], directory);
  return directory;
}

function fixture(): { directory: string; repoPath: string; worktreeRoot: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentdock-git-"));
  const repoPath = createRepository(join(directory, "repo"));
  return { directory, repoPath, worktreeRoot: join(directory, "worktrees") };
}

type App = ReturnType<typeof createApplication>;
function project(app: App, f: ReturnType<typeof fixture>, name = "alpha") { return app.projects.create({ name, repoPath: f.repoPath, worktreeRoot: f.worktreeRoot }); }

test("prepare creates an isolated worktree and branch and moves the task to READY", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id);
    assert.equal(prepared.state, "READY");
    assert.equal(prepared.branch, `agentdock/${created.id}`);
    assert.equal(prepared.worktreePath, join(f.worktreeRoot, created.id));
    assert.ok(existsSync(prepared.worktreePath!));
    assert.ok(existsSync(join(prepared.worktreePath!, "README.md")));
    assert.match(gitOutput(["branch", "--list", `agentdock/${created.id}`], f.repoPath), new RegExp(created.id));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepare is idempotent while the worktree exists", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const first = await app.worktrees.prepare(created.id);
    const second = await app.worktrees.prepare(created.id);
    assert.equal(second.state, "READY");
    assert.equal(second.branch, first.branch);
    assert.equal(second.worktreePath, first.worktreePath);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("two tasks in the same project get isolated worktrees", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const p = project(app, f);
    const a = (await app.worktrees.prepare(app.tasks.create(p.id, "Feature A").task.id))!;
    const b = (await app.worktrees.prepare(app.tasks.create(p.id, "Feature B").task.id))!;
    assert.notEqual(a.worktreePath, b.worktreePath);
    writeFileSync(join(a.worktreePath!, "feature-a.txt"), "feature a\n");
    git(["add", "."], a.worktreePath!); git(["commit", "-m", "feature a"], a.worktreePath!);
    assert.ok(!existsSync(join(b.worktreePath!, "feature-a.txt")));
    assert.equal((await app.worktrees.status(b.id)).files.length, 0);
    assert.equal(await app.worktrees.diff(b.id), "");
    assert.match(await app.worktrees.diff(a.id), /feature-a\.txt/);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("tasks in different projects use their own worktree roots", async () => {
  const f1 = fixture(); const f2 = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const p1 = project(app, f1, "one"); const p2 = project(app, f2, "two");
    const t1 = await app.worktrees.prepare(app.tasks.create(p1.id, "Project one task").task.id);
    const t2 = await app.worktrees.prepare(app.tasks.create(p2.id, "Project two task").task.id);
    assert.equal(t1.worktreePath, join(f1.worktreeRoot, t1.id));
    assert.equal(t2.worktreePath, join(f2.worktreeRoot, t2.id));
  } finally { db.close(); rmSync(f1.directory, { recursive: true, force: true }); rmSync(f2.directory, { recursive: true, force: true }); }
});

test("cleanup removes the worktree and branch and returns the task to DRAFT", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    const cleaned = await app.worktrees.cleanup(created.id);
    assert.equal(cleaned.state, "DRAFT");
    assert.equal(cleaned.branch, null);
    assert.equal(cleaned.worktreePath, null);
    assert.ok(!existsSync(path));
    assert.equal(gitOutput(["branch", "--list", `agentdock/${created.id}`], f.repoPath).trim(), "");
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("cleanup of a dirty worktree requires force", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id);
    writeFileSync(join(prepared.worktreePath!, "dirty.txt"), "uncommitted\n");
    await assert.rejects(() => app.worktrees.cleanup(created.id), /--force/);
    const cleaned = await app.worktrees.cleanup(created.id, { force: true });
    assert.equal(cleaned.state, "DRAFT");
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepare rejects tasks in paused or disabled projects", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const p = project(app, f); const created = app.tasks.create(p.id, "Add a feature").task;
    app.projects.setStatus(p.id, "PAUSED");
    await assert.rejects(() => app.worktrees.prepare(created.id), /PAUSED/);
    app.projects.setStatus(p.id, "DISABLED");
    await assert.rejects(() => app.worktrees.prepare(created.id), /DISABLED/);
    assert.throws(() => app.projects.setStatus(p.id, "bogus"), /status must be one of/);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepare reports unusable repositories clearly", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const notARepo = join(f.directory, "not-a-repo"); mkdirSync(notARepo);
    const broken = app.projects.create({ name: "broken", repoPath: notARepo, worktreeRoot: f.worktreeRoot });
    await assert.rejects(() => app.worktrees.prepare(app.tasks.create(broken.id, "x").task.id), /not a Git work tree/);
    const wrongBase = app.projects.create({ name: "wrong-base", repoPath: f.repoPath, worktreeRoot: f.worktreeRoot, baseBranch: "nonexistent" });
    await assert.rejects(() => app.worktrees.prepare(app.tasks.create(wrongBase.id, "x").task.id), /Base branch nonexistent not found/);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepare recovers a worktree deleted from disk while the branch remains", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "recovered.txt"), "committed work\n");
    git(["add", "."], path); git(["commit", "-m", "task work"], path);
    rmSync(path, { recursive: true, force: true });
    const recovered = await app.worktrees.prepare(created.id);
    assert.equal(recovered.state, "READY");
    assert.equal(recovered.worktreePath, path);
    assert.ok(existsSync(join(path, "recovered.txt")));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("task status and diff reflect worktree changes", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "feature.txt"), "committed\n");
    git(["add", "."], path); git(["commit", "-m", "feature"], path);
    const clean = await app.worktrees.status(created.id);
    assert.equal(clean.branch, `agentdock/${created.id}`);
    assert.equal(clean.baseBranch, "main");
    assert.match(clean.headSha, /^[0-9a-f]{40}$/);
    assert.equal(clean.files.length, 0);
    writeFileSync(join(path, "uncommitted.txt"), "dirty\n");
    const dirty = await app.worktrees.status(created.id);
    assert.deepEqual(dirty.files, [{ status: "??", path: "uncommitted.txt" }]);
    assert.match(await app.worktrees.diff(created.id, { stat: true }), /feature\.txt/);
    assert.match(await app.worktrees.diff(created.id), /feature\.txt/);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("project validate reports repository issues", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const good = await app.worktrees.validateProject(project(app, f).id);
    assert.equal(good.ok, true);
    assert.deepEqual(good.issues, []);
    const notARepo = join(f.directory, "not-a-repo"); mkdirSync(notARepo);
    const broken = app.projects.create({ name: "broken", repoPath: notARepo, worktreeRoot: f.worktreeRoot, baseBranch: "main" });
    const bad = await app.worktrees.validateProject(broken.id);
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some((issue) => issue.includes("not a Git work tree")));
    assert.ok(bad.issues.some((issue) => issue.includes("base branch main not found")));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("cleanup refuses to discard unmerged commits and leaves the task untouched", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "work.txt"), "committed work\n");
    git(["add", "."], path); git(["commit", "-m", "task work"], path);
    await assert.rejects(() => app.worktrees.cleanup(created.id), /not merged into main/);
    assert.ok(existsSync(path));
    assert.match(gitOutput(["branch", "--list", `agentdock/${created.id}`], f.repoPath), new RegExp(created.id));
    assert.equal(app.repositories.tasks.findById(created.id)!.state, "READY");
    const cleaned = await app.worktrees.cleanup(created.id, { force: true });
    assert.equal(cleaned.state, "DRAFT");
    assert.ok(!existsSync(path));
    assert.equal(gitOutput(["branch", "--list", `agentdock/${created.id}`], f.repoPath).trim(), "");
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("cleanup without force succeeds once the branch is merged", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "work.txt"), "committed work\n");
    git(["add", "."], path); git(["commit", "-m", "task work"], path);
    git(["merge", "--no-edit", `agentdock/${created.id}`], f.repoPath);
    const cleaned = await app.worktrees.cleanup(created.id);
    assert.equal(cleaned.state, "DRAFT");
    assert.ok(!existsSync(path));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("cleanup succeeds when the main worktree is checked out on another branch", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "work.txt"), "committed work\n");
    git(["add", "."], path); git(["commit", "-m", "task work"], path);
    // main is checked out elsewhere and does not contain the task commits, but baseBranch does
    git(["checkout", "-q", "-b", "other"], f.repoPath);
    git(["update-ref", "refs/heads/main", `agentdock/${created.id}`], f.repoPath);
    const cleaned = await app.worktrees.cleanup(created.id);
    assert.equal(cleaned.state, "DRAFT");
    assert.ok(!existsSync(path));
    assert.equal(gitOutput(["branch", "--list", `agentdock/${created.id}`], f.repoPath).trim(), "");
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepare recovers a crash between worktree creation and the database update", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id);
    db.prepare("UPDATE tasks SET state = 'DRAFT', branch = NULL, worktree_path = NULL WHERE id = ?").run(created.id);
    const recovered = await app.worktrees.prepare(created.id);
    assert.equal(recovered.state, "READY");
    assert.equal(recovered.branch, prepared.branch);
    assert.equal(recovered.worktreePath, prepared.worktreePath);
    assert.ok(existsSync(recovered.worktreePath!));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("task status preserves staged, unstaged, and renamed paths", async () => {
  const f = fixture(); const db = openDatabase(":memory:");
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Add a feature").task;
    const prepared = await app.worktrees.prepare(created.id); const path = prepared.worktreePath!;
    writeFileSync(join(path, "staged.txt"), "one\n"); git(["add", "staged.txt"], path);
    writeFileSync(join(path, "staged.txt"), "one\ntwo\n");
    git(["mv", "README.md", "RENAMED.md"], path);
    const status = await app.worktrees.status(created.id);
    assert.deepEqual(status.files, [
      { status: "R ", path: "RENAMED.md" },
      { status: "AM", path: "staged.txt" },
    ]);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("prepared task persists across database reopen", async () => {
  const f = fixture(); const dbPath = join(f.directory, "data", "agentdock.db");
  let db: Database = openDatabase(dbPath); let taskId: string;
  try {
    const app = createApplication(db); const created = app.tasks.create(project(app, f).id, "Persisted task");
    taskId = created.task.id;
    await app.worktrees.prepare(taskId);
  } finally { db.close(); }
  db = openDatabase(dbPath);
  try {
    const task = createApplication(db).tasks.show(taskId).task;
    assert.equal(task.state, "READY");
    assert.equal(task.branch, `agentdock/${taskId}`);
    assert.ok(task.worktreePath);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
