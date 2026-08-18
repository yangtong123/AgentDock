# AgentDock

AgentDock is a multi-project coding-agent orchestrator. It coordinates Claude Code and Codex as interchangeable providers across durable tasks, isolated Git worktrees, configurable workflows, deterministic verification, bounded review/fix loops, and human approval gates — controlled from Telegram, Feishu/Lark, or the local CLI.

**Status: V1.0** — all roadmap milestones through V1.0 are implemented. See [the roadmap](docs/ROADMAP.md).

## What it does

- **Multiple projects and tasks** with durable state in SQLite; every task runs in an isolated Git worktree (`agentdock/<task-id>` branch).
- **Claude Code and Codex as providers**, configurable per workflow step. Session resume with fallback to durable task context when a session is lost.
- **Workflows**: `fast` (implement → verify), `cross-review` (implement → verify → review → fix loop → final review), `careful` (adds plan + human approval gates), and `fix` (re-entry for CI/review failures). Bounded review/fix loops with `maxReviewRounds`.
- **Deterministic verification** outranks LLM review: projects declare a verify command (argv array) that the VERIFY step executes in the worktree.
- **Reliability**: worker leases and heartbeats, task queue with priority/scheduling and global/per-project concurrency, owner-scoped process-tree cancellation, task timeouts, orphan recovery, transactional outbox with lease-based delivery, idempotent IM commands.
- **Human approval gates** with interactive approve/reject buttons in Telegram and Feishu.
- **Telegram + Feishu/Lark** share one domain control model: a task created in one IM is visible and controllable from the other.
- **GitHub**: branch push, Draft PR (never auto-merges), CI status, CI-failure and PR-review ingestion feeding fix workflows.
- **Security**: agent sandboxes (provider-native permission modes + OS-level write jail), secret isolation, permission profiles, audit log; observability with metrics, usage/duration tracking, and per-task budget caps.

## Prerequisites and installation

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`)
- Git **2.28 or newer**
- Optional: `claude` and/or `codex` CLI on PATH (agents to orchestrate), `gh` CLI authenticated (GitHub integration)
- Optional (Linux only): `bubblewrap` for the OS-level sandbox — without it, sandbox profiles refuse to run rather than execute unsandboxed

```bash
npm install
npm run build
```

## Quick start

```bash
# 1. Register a project (verify command is optional but recommended)
npm run cli -- project add --name api \
  --repo-path /repos/api \
  --worktree-root /worktrees/api \
  --verify-command '["npm","test"]' \
  --permission-profile default

# 2. Create a task and its isolated worktree
npm run cli -- task create --project-id <project-id> --request "Add health endpoint"
npm run cli -- task prepare --task-id <task-id>

# 3. Run a workflow and watch the steps
npm run cli -- workflow start --task-id <task-id> --preset cross-review
npm run cli -- workflow execute --run-id <run-id>
npm run cli -- workflow status  --run-id <run-id>

# 4. After a SUCCEEDED task, deliver via GitHub
npm run cli -- github create-pr --task-id <task-id> --title "Add health endpoint"
```

## Long-running service

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run cli -- serve
# or: TELEGRAM_BOT_TOKEN=... npm run cli -- serve
```

`serve` runs the full production stack: IM adapters, the orchestrator (leases, concurrency, timeouts, crash recovery), and the outbox dispatcher (terminal run events notify the IM conversation that started the task).

Feishu has two transports; the long-connection one is the simple mode (no public URL, tunnel, or verification token, and the SDK renews `tenant_access_token` itself):

- **Long connection (recommended)**: set `FEISHU_APP_ID` + `FEISHU_APP_SECRET`. In the developer console enable the bot capability, grant `im:message` + `im:message:send_as_bot`, subscribe `im.message.receive_v1`, select **long connection (长连接)** as the delivery mode, and publish the app. Note: the SDK's long connection does not deliver card callbacks, so approval prompts arrive as text — reply `/approve RUN_ID` or `/reject RUN_ID`.
- **Webhook**: set `FEISHU_WEBHOOK_PORT` (plus `FEISHU_VERIFICATION_TOKEN` and `FEISHU_TENANT_TOKEN`) and point the event subscription URL and the card callback URL (回调配置 → 卡片回传交互) at the server. The webhook transport renders interactive approve/reject cards; also subscribe `card.action.trigger`.

IM commands: `/projects`, `/use NAME`, `/new REQUEST`, `/run TASK PRESET`, `/tasks`, `/status TASK`, `/diff TASK`, `/stop TASK`, `/approve RUN_ID`, `/reject RUN_ID`, plus interactive approve/reject buttons at approval gates (Telegram and Feishu webhook). Restrict access with `ALLOWED_CHAT_IDS` (Telegram) / `FEISHU_ALLOWED_CHAT_IDS` and verify Feishu webhooks with `FEISHU_VERIFICATION_TOKEN`.

## Agent sandboxing

Agents never run unsandboxed by default. Two layers, selected per project via `--permission-profile`:

| Profile | Provider-native (layer 1) | OS write-jail (layer 2) |
| --- | --- | --- |
| `default` | claude `acceptEdits` + tool allowlist; codex: off (its sandbox cannot nest under the OS jail) | seatbelt (macOS) / bwrap (Linux), fail-closed |
| `restricted` / `sandboxed` | same, shorter step timeouts | same, fail-closed |
| `full-access` | legacy dangerous flags | none — for externally isolated setups |

The write jail confines agent writes to the task worktree plus agent config dirs; writes elsewhere are EPERM-denied. `full-access` exists only for projects that manage isolation themselves. Orchestrator secrets (tokens, keys) are stripped from agent environments regardless of profile.

## Database

Default: `.agentdock/agentdock.db`; override with `AGENTDOCK_DB`. Migrations in `migrations/` apply automatically on open (lexically ordered, recorded in `schema_migrations`) or explicitly via `npm run migrate`.

## CLI reference

`npm run cli -- --help` lists everything: project/task/workflow/github/metrics/audit subcommands. Highlights:

```bash
npm run cli -- workflow start --task-id ID --preset careful --provider REVIEW=codex --provider IMPLEMENT=claude
npm run cli -- workflow approve --run-id ID [--reject]
npm run cli -- github refresh --task-id ID      # poll PR/CI; failures auto-trigger fix runs under `serve`
npm run cli -- metrics summary                 # step/task aggregates
npm run cli -- metrics usage --task-id ID      # per-agent duration + tokens
npm run cli -- audit --task-id ID              # who did what
```

## Development

```bash
npm run typecheck
npm test
```

Architecture: domain services own operations; SQLite repositories encapsulate SQL; every external system (git, Telegram, Feishu, GitHub, agent CLIs) sits behind a port/adapter. All process execution uses argv arrays with shell disabled — IM/user text never reaches a shell. The orchestrator owns all workflow state; agents never control the global workflow.
