import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../dist/src/db/database.js";
import { createApplication } from "../../dist/src/app/application.js";
import { createRepository } from "../../dist/tests/helpers.js";
import { Orchestrator } from "../../dist/src/reliability/orchestrator.js";
import { createGateway } from "../../dist/src/gateway/server.js";
import type { AgentRunContext } from "../../dist/src/runtime/coding-agent.js";

/**
 * E2E fixture: a REAL gateway + orchestrator over a temp file DB with fake
 * coding agents that make cross-review/careful runs progress deterministically.
 * The agent "works" in the git worktree so diffs/artifacts/logs are all real.
 */
function fakeAgent(provider: string) {
  // REVIEW requests fixes once per worktree, then passes — one bounded fix round.
  const reviewedOnce = new Set<string>();
  return {
    provider,
    async run(context: AgentRunContext) {
      const base = { exitCode: 0, stderr: "", externalSessionId: `${provider}-session`, resumed: false };
      switch (context.role) {
        case "PLAN":
          return { ...base, stdout: "plan: implement feature.txt, verify, review" };
        case "IMPLEMENT":
          writeFileSync(join(context.worktreePath, "feature.txt"), "hello from e2e\n");
          return { ...base, stdout: "implemented feature.txt" };
        case "REVIEW":
          if (!reviewedOnce.has(context.worktreePath)) {
            reviewedOnce.add(context.worktreePath);
            return { ...base, stdout: "FINDING [MINOR] feature.txt:1 add a trailing second line\nVERDICT: NEEDS_FIXES" };
          }
          return { ...base, stdout: "VERDICT: PASS" };
        case "FIX":
          appendFileSync(join(context.worktreePath, "feature.txt"), "fixed by e2e\n");
          return { ...base, stdout: "fixed the finding" };
        case "FINAL_REVIEW":
          return { ...base, stdout: "VERDICT: PASS" };
        default:
          return { ...base, stdout: "ok" };
      }
    },
  };
}

export interface E2EFixture {
  url: string;
  token: string;
  base: string;
  stop(): Promise<void>;
}

export async function startFixture(): Promise<E2EFixture> {
  const base = mkdtempSync(join(tmpdir(), "agentdock-e2e-"));
  createRepository(join(base, "repo"));
  process.env.AGENTDOCK_ARTIFACTS = join(base, "artifacts");
  const db = openDatabase(join(base, "e2e.db"));
  const app = createApplication(db, { agents: { claude: fakeAgent("claude"), codex: fakeAgent("codex") } });
  app.projects.create({
    name: "e2e",
    repoPath: join(base, "repo"),
    worktreeRoot: join(base, "wt"),
    verifyCommand: [process.execPath, "-e", "process.exit(0)"],
  });
  const orchestrator = new Orchestrator(db, app, app.processRunner, { pollMs: 25, activity: app.activity });
  await orchestrator.start();
  const token = "e2e-token";
  const gateway = createGateway({ db, app, queue: orchestrator.queue, orchestrator, host: "127.0.0.1", port: 0, token, ssePollIntervalMs: 25 });
  const { url } = await gateway.start();
  return {
    url,
    token,
    base,
    async stop() {
      await gateway.stop();
      await orchestrator.stop();
      db.close();
      rmSync(base, { recursive: true, force: true });
      delete process.env.AGENTDOCK_ARTIFACTS;
    },
  };
}
