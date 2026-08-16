# AgentDock

AgentDock is a multi-project coding-agent orchestrator. It is designed to coordinate provider-neutral coding agents across durable tasks, isolated repositories, configurable workflows, and deterministic verification.

## Status: V0.2 — Multi-project + Git Worktree

V0.2 adds Git worktree isolation on top of the V0.1 foundation: projects reference real Git repositories, tasks get isolated worktrees and branches (`agentdock/<task-id>` under the project's `worktreeRoot`), and the CLI can prepare/clean up worktrees and inspect task status/diff. It deliberately does **not** run coding agents or workflows.

See [the roadmap](docs/ROADMAP.md) and [the V0.1 development contract](docs/tasks/V0.1-CODEX-TASK.md).

## Prerequisites and installation

- Node.js **22.13 or newer** (the implementation uses the built-in `node:sqlite` API)
- Git **2.28 or newer**
- npm

```bash
npm install
npm run build
```

## Database and migrations

The CLI uses `.agentdock/agentdock.db` by default. Set `AGENTDOCK_DB` to use another SQLite file. The parent directory is created automatically, foreign keys are enabled on every connection, and pending migrations run whenever the application opens the database.

To run migrations explicitly:

```bash
AGENTDOCK_DB=/absolute/path/agentdock.db npm run migrate
```

Migrations in `migrations/` are applied once in lexical order and recorded in `schema_migrations`. Keep applied migrations immutable; add a new numbered migration for schema changes.

## Local CLI

Commands compile the TypeScript application before execution. Output is JSON so it can be inspected or piped to other local tools.

```bash
# Create and list projects
npm run cli -- project add --name api --repo-path /repos/api --worktree-root /worktrees/api --base-branch main
npm run cli -- project list

# Use the project ID returned above
npm run cli -- task create --project-id <project-id> --request "Add health endpoint"
npm run cli -- task list --project-id <project-id>
npm run cli -- task show --task-id <task-id>

# Preserve revision 1 and make revision 2 current
npm run cli -- task revise --task-id <task-id> --request "Add readiness and liveness endpoints"

# Isolated worktrees (repo-path must be a Git work tree with the base branch)
npm run cli -- project validate --project-id <project-id>
npm run cli -- task prepare --task-id <task-id>   # creates <worktree-root>/<task-id> + branch agentdock/<task-id>
npm run cli -- task status --task-id <task-id>    # branch, HEAD/base SHA, changed files
npm run cli -- task diff --task-id <task-id> --stat
npm run cli -- task cleanup --task-id <task-id>   # removes worktree + branch; --force also discards dirty worktrees and unmerged commits
npm run cli -- project set-status --project-id <project-id> --status PAUSED   # ACTIVE|PAUSED|DISABLED
```

`task prepare` is idempotent and recovers from a deleted worktree directory as long as the branch survives (Git is the source of truth). Tasks in PAUSED/DISABLED projects cannot be prepared.

Use the same `AGENTDOCK_DB` value on later invocations to reopen and inspect persisted data.

## Development

```bash
npm run typecheck
npm test
```

The core is split into domain-focused modules under `src/`. Services own operations such as atomically creating a Task and its initial TaskRevision; SQLite repositories encapsulate SQL. `src/git/` contains the `GitService` (execFile-based, argument arrays only, shell disabled) and the `WorktreeManager` that owns the branch/worktree lifecycle. Workflow, agent-thread, and artifact modules remain persistence abstractions until later milestones.

## Intentionally deferred

Coding-agent execution (Codex and Claude), process runners for agents, workflow execution, schedulers, Telegram, Feishu/Lark, GitHub integration, Redis, and a web dashboard belong to future roadmap milestones (agent runtime starts in V0.3).
