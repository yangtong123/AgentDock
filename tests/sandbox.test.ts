import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessRunner } from "../src/runtime/process-runner.js";
import { OsSandbox, SandboxUnavailableError } from "../src/runtime/os-sandbox.js";
import { PROFILES, resolveProfile } from "../src/security/permissions.js";
import { ClaudeAgent, CodexAgent, EnvCodingAgent, defaultCaBundlePath } from "../src/runtime/env-agents.js";

function spyRunner(): { runner: ProcessRunner; argv: () => string[]; env: () => Record<string, string> } {
  let lastArgv: string[] = [];
  let lastEnv: Record<string, string> = {};
  const runner = {
    run: async (options: { argv: string[]; env: Record<string, string> }) => {
      lastArgv = options.argv;
      lastEnv = options.env;
      return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
    },
  } as unknown as ProcessRunner;
  return { runner, argv: () => lastArgv, env: () => lastEnv };
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
  const allowedIndex = args.indexOf("--allowedTools");
  const disallowedIndex = args.indexOf("--disallowedTools");
  const allowedList = args.slice(allowedIndex + 1, disallowedIndex);
  assert.ok(!allowedList.some((tool) => tool.startsWith("Bash(node") || tool.startsWith("Bash(npm") || tool.startsWith("Bash(npx")), "no arbitrary-code Bash entries");

  const fullAccess = new ClaudeAgent(runner);
  await fullAccess.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: { ...PROFILES["default"]!, providerMode: "full-access" } });
  assert.equal(argv().includes("--dangerously-skip-permissions"), true, "explicit full-access opt-in keeps the old flag");
});

test("layer 1: codex relies on the OS jail when one is enforced (inner sandbox cannot nest)", async () => {
  const { runner, argv, env } = spyRunner();
  const codex = new CodexAgent(runner);
  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: PROFILES["default"]! });
  const args = argv();
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false, "dangerous flag must be gone");
  // macOS denies codex's inner sandbox_apply under the outer Seatbelt jail;
  // with layer 2 enforced (fail-closed), codex's own sandbox stays off.
  assert.equal(args[args.indexOf("-s") + 1], "danger-full-access");
  assert.equal(args.includes("sandbox_workspace_write.network_access=true"), false);
  // TLS roots come from a file bundle: rustls must not need macOS trustd/
  // securityd XPC, keeping the Seatbelt profile free of broker access. The
  // bundle path is platform-dependent — assert whatever the resolver selects.
  const bundle = defaultCaBundlePath();
  if (bundle !== null) assert.equal(env().SSL_CERT_FILE, bundle);
  else assert.equal("SSL_CERT_FILE" in env(), false);

  await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: PROFILES["full-access"]! });
  assert.equal(argv().includes("--dangerously-bypass-approvals-and-sandbox"), true, "explicit full-access opt-in keeps the old flag");
  assert.equal("SSL_CERT_FILE" in env(), false, "full-access runs unsandboxed: the system trust chain (enterprise Keychain CAs) stays in use");
});

test("layer 2: bwrap argv exposes per-invocation extra read paths (custom CA bundle)", () => {
  const argv = OsSandbox.bwrapArgv(PROFILES["restricted"]!, "/wt", ["codex", "exec"], ["/opt/enterprise-ca.pem"]);
  const index = argv.findIndex((arg, i) => arg === "--ro-bind-try" && argv[i + 1] === "/opt/enterprise-ca.pem");
  assert.ok(index >= 0, "a custom CA file outside /etc is read-only bound into the namespace");
});

test("provider envExtra cannot smuggle proxy credentials past screening", async () => {
  const { runner, env } = spyRunner();
  const agent = new EnvCodingAgent(runner, {
    provider: "custom",
    binary: "custom-cli",
    argv: () => ["custom-cli", "run"],
    envExtra: () => ({ HTTPS_PROXY: "http://alice:secret@proxy:8080" }),
    parseSessionId: () => null,
  });
  await agent.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {}, profile: PROFILES["default"]! });
  assert.equal(env().HTTPS_PROXY, "http://proxy:8080/", "envExtra proxy credentials are stripped like any other source");
});

test("layer 2 (integration): bwrap write-jail blocks writes outside the worktree", async () => {
  if (process.platform !== "linux") return; // bwrap is linux-only
  const base = mkdtempSync(join(tmpdir(), "agentdock-bwrap-"));
  const worktree = join(base, "wt"); const outside = join(base, "outside");
  mkdirSync(worktree, { recursive: true }); mkdirSync(outside, { recursive: true });
  try {
    const profile = PROFILES["restricted"]!;
    const outsidePlan = OsSandbox.plan(profile, worktree, ["/usr/bin/sh", "-c", 'echo x > "$1"', "sh", join(outside, "escaped.txt")]);
    if (outsidePlan.mechanism !== "bwrap") return; // namespaces unavailable on this host
    const runner = new ProcessRunner();
    await runner.run({ cwd: worktree, argv: outsidePlan.argv, env: { PATH: process.env.PATH! }, timeoutMs: 10_000 }).catch(() => null);
    assert.equal(existsSync(join(outside, "escaped.txt")), false, "write outside the worktree must be blocked");
    const insidePlan = OsSandbox.plan(profile, worktree, ["/usr/bin/sh", "-c", 'echo x > "$1"', "sh", join(worktree, "ok.txt")]);
    await runner.run({ cwd: worktree, argv: insidePlan.argv, env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
    assert.equal(existsSync(join(worktree, "ok.txt")), true, "write inside the worktree must succeed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("layer 2: seatbelt profile denies writes outside allowlisted paths", () => {
  const profile = PROFILES["restricted"]!;
  const worktree = "/tmp/agentdock-wt";
  const sbProfile = OsSandbox.seatbeltProfile(profile, worktree);
  assert.match(sbProfile, /\(deny default\)/);
  assert.match(sbProfile, new RegExp(`subpath "${worktree}"`));
  // Network is allowed at the OS layer: the agent CLI's model-API traffic needs it.
  assert.match(sbProfile, /allow network\*/);
  // No macOS system brokers: mach-lookup to trustd/securityd/configd etc. would
  // give a compromised agent XPC access to credential-adjacent services. Codex
  // gets TLS roots via SSL_CERT_FILE instead (see CodexAgent).
  assert.equal(sbProfile.includes("mach-lookup"), false, "seatbelt must not grant mach-lookup to system brokers");
  // Codex's config.toml stays read-only (no planting MCP servers/settings for
  // future runs). SBPL: later rules win, so the deny must follow the allows.
  const denyIndex = sbProfile.indexOf('(deny file-write* (literal');
  const lastAllowIndex = sbProfile.lastIndexOf("(allow file-write* (subpath");
  assert.ok(denyIndex > lastAllowIndex && denyIndex > 0, "config.toml deny must come after the write allows");
  assert.match(sbProfile, /\.codex\/config\.toml/);
});

test("layer 2: plan() resolves write-jail per platform and fails closed when unenforceable", () => {
  const profile = PROFILES["restricted"]!;
  const wrapped = OsSandbox.plan(profile, "/wt", ["claude", "-p", "hi"]);
  if (process.platform === "darwin") {
    assert.equal(wrapped.mode, "write-jail");
    assert.equal(wrapped.mechanism, "seatbelt");
    assert.deepEqual(wrapped.argv.slice(0, 2), ["sandbox-exec", "-p"]);
    assert.deepEqual(wrapped.argv.slice(4), ["claude", "-p", "hi"]);
    assert.equal(wrapped.fallbackReason, null);
  } else {
    // Non-darwin without bwrap: fail-closed profiles refuse rather than run unsandboxed.
    assert.throws(() => OsSandbox.plan(profile, "/wt", ["claude"], { bwrapAvailable: false }), SandboxUnavailableError);
  }
  const none = OsSandbox.plan(PROFILES["full-access"]!, "/wt", ["claude"]);
  assert.equal(none.mode, "none");
  assert.deepEqual(none.argv, ["claude"]);

  if (process.platform !== "darwin") {
    // Linux with bwrap: write-jail resolves to bwrap; network stays up for the model API.
    OsSandbox.setBwrapAvailable(true);
    try {
      const bwrapPlan = OsSandbox.plan(profile, "/wt", ["codex", "exec"]);
      assert.equal(bwrapPlan.mode, "write-jail");
      assert.equal(bwrapPlan.mechanism, "bwrap");
      assert.ok(!bwrapPlan.argv.includes("--unshare-net"));
      // Without bwrap and fail-closed: refused. Non-fail-closed: degraded with a note.
      const degraded = OsSandbox.plan({ ...profile, failClosed: false }, "/wt", ["codex"], { bwrapAvailable: false });
      assert.equal(degraded.mode, "none");
      assert.match(degraded.fallbackReason!, /no mechanism exists/);
    } finally { OsSandbox.setBwrapAvailable(null); }
  }
});

test("layer 2: fail-closed profiles surface refusal as a failed step, never run unsandboxed", async () => {
  if (process.platform === "darwin") return; // darwin always has seatbelt
  const { runner, argv } = spyRunner();
  const codex = new CodexAgent(runner);
  OsSandbox.setBwrapAvailable(false);
  try {
    const outcome = await codex.run({ taskId: "t", role: "IMPLEMENT", worktreePath: "/wt", profile: PROFILES["restricted"]!, prompt: "p", resumeSessionId: null, revisionRequest: "r", timeoutMs: 1000, env: {} });
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.stderr, /OS sandbox unavailable/);
    assert.deepEqual(argv(), [], "no process was spawned");
  } finally { OsSandbox.setBwrapAvailable(null); }
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
  assert.equal(resolveProfile("restricted").osSandbox, "write-jail");
  assert.throws(() => resolveProfile("bogus"), /Unknown permission profile/);
});
