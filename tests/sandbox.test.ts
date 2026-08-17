import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessRunner } from "../src/runtime/process-runner.js";
import { OsSandbox } from "../src/runtime/os-sandbox.js";
import { PROFILES, resolveProfile } from "../src/security/permissions.js";
import { ClaudeAgent, CodexAgent } from "../src/runtime/env-agents.js";

function spyRunner(): { runner: ProcessRunner; argv: () => string[] } {
  let lastArgv: string[] = [];
  const runner = {
    run: async (options: { argv: string[] }) => {
      lastArgv = options.argv;
      return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
    },
  } as unknown as ProcessRunner;
  return { runner, argv: () => lastArgv };
}

test("layer 1: claude uses permission mode + tool allowlist unless full-access", async () => {
  const { runner, argv } = spyRunner();
  const claude = new ClaudeAgent(runner);
  await claude.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: PROFILES["default"]! });
  const args = argv();
  assert.equal(args.includes("--dangerously-skip-permissions"), false, "dangerous flag must be gone");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(args.includes("--allowedTools"));
  assert.ok(args.includes("--disallowedTools"), "web tools are denied");

  const fullAccess = new ClaudeAgent(runner);
  await fullAccess.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: { ...PROFILES["default"]!, providerMode: "full-access" } });
  assert.equal(argv().includes("--dangerously-skip-permissions"), true, "explicit full-access opt-in keeps the old flag");
});

test("layer 1: codex uses workspace-write sandbox unless full-access", async () => {
  const { runner, argv } = spyRunner();
  const codex = new CodexAgent(runner);
  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: PROFILES["default"]! });
  const args = argv();
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false, "dangerous flag must be gone");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.match(args.join(" "), /sandbox_workspace_write\.network_access/);

  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: { ...PROFILES["default"]!, providerMode: "full-access" } });
  assert.equal(argv().includes("--dangerously-bypass-approvals-and-sandbox"), true, "explicit full-access opt-in keeps the old flag");
});

test("layer 2: seatbelt profile denies writes outside allowlisted paths", () => {
  const profile = PROFILES["restricted"]!;
  const worktree = "/tmp/agentdock-wt";
  const sbProfile = OsSandbox.seatbeltProfile(profile, worktree);
  assert.match(sbProfile, /\(deny default\)/);
  assert.match(sbProfile, new RegExp(`subpath "${worktree}"`));
  // Network is allowed at the OS layer: the agent CLI's model-API traffic needs it.
  assert.match(sbProfile, /allow network\*/);
});

test("layer 2: plan() wraps argv with sandbox-exec on darwin, degrades elsewhere", () => {
  const profile = PROFILES["restricted"]!;
  const wrapped = OsSandbox.plan(profile, "/wt", ["claude", "-p", "hi"]);
  if (process.platform === "darwin") {
    assert.equal(wrapped.mode, "macos-seatbelt");
    assert.deepEqual(wrapped.argv.slice(0, 3), ["sandbox-exec", "-p", wrapped.argv[2]!]);
    assert.deepEqual(wrapped.argv.slice(4), ["claude", "-p", "hi"]);
    assert.equal(wrapped.fallbackReason, null);
  } else {
    assert.equal(wrapped.mode, "none");
    assert.match(wrapped.fallbackReason!, /non-darwin/);
  }
  const none = OsSandbox.plan(PROFILES["full-access"]!, "/wt", ["claude"]);
  assert.equal(none.mode, "none");
  assert.deepEqual(none.argv, ["claude"]);

  const linux = OsSandbox.plan({ ...PROFILES["restricted"]!, osSandbox: "linux-bwrap" }, "/wt", ["codex", "exec"], { bwrapAvailable: false });
  assert.equal(linux.mode, "none");
  assert.match(linux.fallbackReason!, /bwrap is not installed/);
  const linuxOk = OsSandbox.plan({ ...PROFILES["restricted"]!, osSandbox: "linux-bwrap" }, "/wt", ["codex", "exec"], { bwrapAvailable: true });
  assert.equal(linuxOk.mode, "linux-bwrap");
  assert.ok(!linuxOk.argv.includes("--unshare-net"), "network stays up for model API");
});

test("layer 2 (integration): sandbox-exec blocks a write outside the worktree", async () => {
  if (process.platform !== "darwin") return; // seatbelt is darwin-only
  const base = mkdtempSync(join(tmpdir(), "agentdock-sbx-"));
  const worktree = join(base, "wt"); const outside = join(base, "outside");
  mkdirSync(worktree, { recursive: true }); mkdirSync(outside, { recursive: true });
  const runner = new ProcessRunner();
  const profile = PROFILES["restricted"]!;
  const writeScript = (target: string) => [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], 'x')", target];
  const sandboxed = (target: string) => OsSandbox.plan(profile, worktree, writeScript(target)).argv;
  try {
    // Sandboxed write outside the worktree: must fail and leave no file.
    const outsideTarget = join(outside, "escaped.txt");
    await runner.run({ cwd: worktree, argv: sandboxed(outsideTarget), env: { PATH: process.env.PATH! }, timeoutMs: 10_000 }).catch(() => null);
    assert.equal(existsSync(outsideTarget), false, "write outside the worktree must be blocked");
    // Sandboxed write inside the worktree: must succeed.
    const okTarget = join(worktree, "ok.txt");
    await runner.run({ cwd: worktree, argv: sandboxed(okTarget), env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
    assert.equal(existsSync(okTarget), true, "write inside the worktree must succeed");
    // Network stays available at the OS layer (model-API traffic depends on it); provider-native sandboxing restricts agent children.
    const netOk = await runner.run({ cwd: worktree, argv: OsSandbox.plan(profile, worktree, [process.execPath, "-e", "require('dns').lookup('localhost',()=>process.exit(0))"]).argv, env: { PATH: process.env.PATH! }, timeoutMs: 10_000 }).catch(() => null);
    void netOk;
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("resolveProfile validates profile names", () => {
  assert.equal(resolveProfile(null).name, "default");
  assert.equal(resolveProfile("restricted").osSandbox, "macos-seatbelt");
  assert.throws(() => resolveProfile("bogus"), /Unknown permission profile/);
});
