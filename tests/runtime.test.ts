import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { ProcessRunner, ProcessTimeoutError, ProcessCancelledError } from "../src/runtime/process-runner.js";
import { EnvCodingAgent, agentEnvironment, ClaudeAgent, CodexAgent } from "../src/runtime/env-agents.js";
import { PROFILES } from "../src/security/permissions.js";
import type { CodingAgent, AgentRunContext, AgentRunOutcome } from "../src/runtime/coding-agent.js";
import { AgentThreadManager } from "../src/runtime/agent-thread-manager.js";
import { SqliteAgentThreadRepository } from "../src/agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../src/artifacts/artifact-repository.js";
import { SqliteTaskRepository } from "../src/tasks/task-repository.js";
import { createRepository } from "./helpers.js";

const runner = new ProcessRunner();

test("ProcessRunner executes argv without a shell and returns output", async () => {
  const result = await runner.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "console.log('hello', process.argv[1])", "world"], env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello world/);
  assert.equal(result.timedOut, false);
});

test("ProcessRunner never lets arguments reach a shell", async () => {
  // If a shell were involved, `; echo pwned` would execute as a second command.
  const result = await runner.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "console.log(process.argv[1])", "x; echo pwned"], env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "x; echo pwned");
});

test("ProcessRunner reports non-zero exit codes", async () => {
  const result = await runner.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "process.exit(3)"], env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 3);
});

test("ProcessRunner throws ProcessTimeoutError on timeout", async () => {
  await assert.rejects(
    runner.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], env: { PATH: process.env.PATH! }, timeoutMs: 150 }),
    ProcessTimeoutError,
  );
});

test("ProcessRunner cancelAll cancels running processes", async () => {
  const local = new ProcessRunner();
  const promise = local.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], env: { PATH: process.env.PATH! }, timeoutMs: 60_000 });
  setTimeout(() => local.cancelAll(), 150);
  await assert.rejects(promise, ProcessCancelledError);
});

test("ProcessRunner kills the whole process tree on timeout", async () => {
  const marker = join(tmpdir(), `agentdock-tree-${Date.now()}`);
  // Child that spawns a grandchild; the grandchild keeps running past the child's death.
  const parent = join(marker, "parent.mjs"); const child = join(marker, "child.mjs");
  mkdirSync(marker, { recursive: true });
  writeFileSync(parent, `import { spawn } from "node:child_process";\nconst c = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore" });\nc.on("exit", () => process.exit(0));\nsetTimeout(() => {}, 60000);\n`);
  writeFileSync(child, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(marker, "grandchild-started"))}, "yes");\nsetTimeout(() => {}, 60000);\n`);
  await assert.rejects(runner.run({ cwd: marker, argv: [process.execPath, parent], env: { PATH: process.env.PATH! }, timeoutMs: 800 }), ProcessTimeoutError);
  // Grandchild started but must be killed with the tree: wait, then check it cannot still be writing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(existsSync(join(marker, "grandchild-started")), "grandchild should have started");
  rmSync(marker, { recursive: true, force: true });
  // If the grandchild survived the tree kill it would recreate its marker file.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(marker), false, "grandchild should have been killed with the tree");
});

test("agentEnvironment only passes through allowlisted variables", () => {
  const env = agentEnvironment({ PATH: "/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "secret", AWS_SECRET: "leak" }, { AGENTDOCK_TASK: "t1" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.AGENTDOCK_TASK, "t1");
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("AWS_SECRET" in env, false);
});

function scriptAgent(provider: string, behavior: (context: AgentRunContext) => { code: number; stdout: string; stderr?: string; sessionId?: string }): CodingAgent {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-script-"));
  const script = join(dir, "agent.sh");
  const encoded = JSON.stringify(behavior);
  writeFileSync(script, `#!/bin/sh\nexec node -e '
  const ctx = JSON.parse(process.argv[1]);
  const behavior = ${encoded};
  const b = behavior(ctx);
  if (b.stdout) process.stdout.write(b.stdout);
  if (b.stderr) process.stderr.write(b.stderr);
  if (b.sessionId) process.stdout.write(JSON.stringify({ session_id: b.sessionId }));
  process.exit(b.code);
' "${'"$AGENTDOCK_CONTEXT"'}"\n`);
  chmodSync(script, 0o755);
  return { provider, async run(context) {
    const outcome: AgentRunOutcome = { exitCode: 0, stdout: "", stderr: "", externalSessionId: null, resumed: false };
    const b = behavior(context);
    outcome.stdout = b.stdout; outcome.stderr = b.stderr ?? "";
    outcome.externalSessionId = b.sessionId ?? null; outcome.resumed = context.resumeSessionId !== null;
    outcome.exitCode = b.code;
    return outcome;
  } };
}

test("AgentThreadManager creates a thread, records session id, and captures stdout/stderr artifacts", async () => {
  const f = createRepository(join(mkdtempSync(join(tmpdir(), "agentdock-rt-")), "repo"));
  const db = openDatabase(":memory:"); const artifactsDir = join(f, "..", "artifacts");
  try {
    const app = createApplication(db);
    const project = app.projects.create({ name: "p", repoPath: f, worktreeRoot: join(f, "..", "wt") });
    const { task } = app.tasks.create(project.id, "do the thing");
    await app.worktrees.prepare(task.id);
    const threads = new SqliteAgentThreadRepository(db); const artifactRepo = new SqliteArtifactRepository(db); const taskRepo = new SqliteTaskRepository(db);
    const agent = scriptAgent("fake", (ctx) => ({ code: 0, stdout: `ran in ${ctx.worktreePath}`, stderr: "warn", sessionId: "sess-123" }));
    const manager = new AgentThreadManager(threads, artifactRepo, taskRepo, () => agent, artifactsDir);
    const execution = await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "implement it", revisionRequest: "do the thing", timeoutMs: 5000 }, "fake");
    assert.equal(execution.failure, null);
    assert.equal(execution.thread.externalSessionId, "sess-123");
    assert.equal(execution.outcome?.resumed, false);
    const stored = threads.findById(execution.thread.id);
    assert.equal(stored?.externalSessionId, "sess-123");
    const captured = artifactRepo.listForTask(task.id);
    assert.ok(captured.some((a) => a.kind === "agent-stdout" && existsSync(a.storage.type === "FILE" ? a.storage.path : "")));
    assert.ok(captured.some((a) => a.kind === "agent-stderr"));
  } finally { db.close(); rmSync(join(f, ".."), { recursive: true, force: true }); }
});

test("AgentThreadManager falls back to a fresh run with durable context when the resume session is lost", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-fb-"));
  const f = createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const project = app.projects.create({ name: "p", repoPath: f, worktreeRoot: join(base, "wt") });
    const { task } = app.tasks.create(project.id, "original request");
    await app.worktrees.prepare(task.id);
    const threads = new SqliteAgentThreadRepository(db); const artifactRepo = new SqliteArtifactRepository(db); const taskRepo = new SqliteTaskRepository(db);
    const calls: AgentRunContext[] = [];
    const agent: CodingAgent = {
      provider: "fake",
      async run(context) {
        calls.push(context);
        if (context.resumeSessionId) return { exitCode: 1, stdout: "unknown session", stderr: "", externalSessionId: null, resumed: true };
        return { exitCode: 0, stdout: `fresh with: ${context.prompt}`, stderr: "", externalSessionId: "sess-new", resumed: false };
      },
    };
    const manager = new AgentThreadManager(threads, artifactRepo, taskRepo, () => agent, join(base, "artifacts"));
    const execution = await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "continue", revisionRequest: "original request", timeoutMs: 5000 }, "fake", { sessionId: "lost-session" });
    assert.equal(execution.failure, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.resumeSessionId, "lost-session");
    assert.equal(calls[1]!.resumeSessionId, null);
    assert.match(calls[1]!.prompt, /original request/);
    assert.equal(execution.thread.externalSessionId, "sess-new");
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("AgentThreadManager reports NON_ZERO_EXIT as failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-nz-"));
  const f = createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const project = app.projects.create({ name: "p", repoPath: f, worktreeRoot: join(base, "wt") });
    const { task } = app.tasks.create(project.id, "request");
    await app.worktrees.prepare(task.id);
    const manager = new AgentThreadManager(new SqliteAgentThreadRepository(db), new SqliteArtifactRepository(db), new SqliteTaskRepository(db), () => scriptAgent("fake", () => ({ code: 2, stdout: "" })), join(base, "artifacts"));
    const execution = await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "p", revisionRequest: "r", timeoutMs: 5000 }, "fake");
    assert.equal(execution.failure?.kind, "NON_ZERO_EXIT");
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("AgentThreadManager resumeThreadId continues an existing thread and updates its session id", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-res-"));
  const f = createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const project = app.projects.create({ name: "p", repoPath: f, worktreeRoot: join(base, "wt") });
    const { task } = app.tasks.create(project.id, "request");
    await app.worktrees.prepare(task.id);
    const threads = new SqliteAgentThreadRepository(db);
    let runs = 0;
    const agent: CodingAgent = {
      provider: "fake",
      async run(context) {
        runs++;
        if (runs === 2) assert.equal(context.resumeSessionId, "old-session");
        return { exitCode: 0, stdout: "resumed", stderr: "", externalSessionId: runs === 1 ? "new-session" : "new-session-2", resumed: context.resumeSessionId !== null };
      },
    };
    const manager = new AgentThreadManager(threads, new SqliteArtifactRepository(db), new SqliteTaskRepository(db), () => agent, join(base, "artifacts"));
    const first = await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "p", revisionRequest: "r", timeoutMs: 5000 }, "fake");
    // Force a stored session id to resume from.
    threads.updateSessionId(first.thread.id, "old-session", new Date().toISOString());
    const resumed = await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "p2", revisionRequest: "r", timeoutMs: 5000 }, "fake", { resumeThreadId: first.thread.id });
    assert.equal(resumed.thread.id, first.thread.id, "resume must reuse the existing thread row, not create a new one");
    assert.equal(threads.findById(first.thread.id)?.externalSessionId, "new-session-2");
    assert.equal(threads.listForTask(task.id).length, 1);
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("AgentThreadManager passes a sanitized environment to the agent", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-env-"));
  const f = createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const project = app.projects.create({ name: "p", repoPath: f, worktreeRoot: join(base, "wt") });
    const { task } = app.tasks.create(project.id, "request");
    await app.worktrees.prepare(task.id);
    let seenEnv: Record<string, string> | undefined;
    const agent: CodingAgent = {
      provider: "fake",
      async run(context) { seenEnv = context.env; return { exitCode: 0, stdout: "", stderr: "", externalSessionId: null, resumed: false }; },
    };
    const manager = new AgentThreadManager(new SqliteAgentThreadRepository(db), new SqliteArtifactRepository(db), new SqliteTaskRepository(db), () => agent, join(base, "artifacts"), () => "now", { ...process.env, SECRET_ORCHESTRATOR_TOKEN: "leak" });
    await manager.run({ taskId: task.id, role: "IMPLEMENT", prompt: "p", revisionRequest: "r", timeoutMs: 5000 }, "fake");
    assert.ok(seenEnv !== undefined);
    assert.equal("SECRET_ORCHESTRATOR_TOKEN" in seenEnv, false, "orchestrator secrets must not leak into agent env");
    assert.equal(seenEnv.AGENTDOCK_TASK_ID, task.id);
    assert.ok(seenEnv.PATH, "PATH must survive so agent CLIs resolve");
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

function spyRunner(overrides: { stdout?: string } = {}): { runner: ProcessRunner; argv: () => string[]; stdin: () => string | undefined } {
  let lastArgv: string[] = [];
  let lastStdin: string | undefined;
  const runner = {
    run: async (options: { argv: string[]; stdin?: string }) => {
      lastArgv = options.argv;
      lastStdin = options.stdin;
      return { stdout: overrides.stdout ?? "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
    },
  } as unknown as ProcessRunner;
  return { runner, argv: () => lastArgv, stdin: () => lastStdin };
}

test("ClaudeAgent and CodexAgent build correct argv with and without resume", async () => {
  const { runner, argv, stdin } = spyRunner();
  // full-access skips the OS wrapper so raw provider argv is observable.
  const raw = PROFILES["full-access"]!;
  const claude = new ClaudeAgent(runner);
  await claude.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: raw, prompt: "do", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {} });
  assert.deepEqual(argv().slice(0, 4), ["claude", "-p", "--output-format", "json"]);
  assert.equal(stdin(), "do", "claude prompt travels via stdin, out of variadic-flag reach");
  assert.equal(argv().includes("do"), false);
  await claude.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: raw, prompt: "more", resumeSessionId: "s1", revisionRequest: "r", timeoutMs: 1000, env: {} });
  assert.deepEqual(argv().slice(4, 6), ["--resume", "s1"]);
  const codex = new CodexAgent(runner);
  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: raw, prompt: "do", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {} });
  assert.deepEqual(argv().slice(0, 3), ["codex", "exec", "--skip-git-repo-check"]);
  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: raw, prompt: "do", resumeSessionId: "s2", revisionRequest: "r", timeoutMs: 1000, env: {} });
  const codexArgs = argv();
  const resumeIndex = codexArgs.indexOf("resume");
  assert.deepEqual(codexArgs.slice(resumeIndex, resumeIndex + 2), ["resume", "s2"]);
});

test("CodexAgent parses session ids from both plain and JSON output", async () => {
  const plain = spyRunner({ stdout: `session id: 12345678-1234-1234-1234-123456789012\nwork work\n` });
  const plainOutcome = await new CodexAgent(plain.runner).run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: PROFILES["default"]!, prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {} });
  assert.equal(plainOutcome.externalSessionId, "12345678-1234-1234-1234-123456789012");
  const json = spyRunner({ stdout: `{"session_id":"abcdefab-cdef-abcd-efab-cdefabcdefab","type":"message"}\n` });
  const jsonOutcome = await new CodexAgent(json.runner).run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: PROFILES["default"]!, prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {} });
  assert.equal(jsonOutcome.externalSessionId, "abcdefab-cdef-abcd-efab-cdefabcdefab");
});
