# AgentDock

AgentDock is a multi-project coding-agent orchestrator. It is designed to coordinate provider-neutral coding agents across durable tasks, isolated repositories, configurable workflows, and deterministic verification.

## Status: V0.1 — Core Foundation

V0.1 implements the durable domain and persistence foundation: Projects, Tasks with immutable requirement revisions, workflow/step run records, agent thread records, artifacts, SQLite migrations, repository/service boundaries, and a local operator CLI. It deliberately does **not** run coding agents or workflows.

See [the roadmap](docs/ROADMAP.md) and [the V0.1 development contract](docs/tasks/V0.1-CODEX-TASK.md).

## Prerequisites and installation

- Node.js **22.13 or newer** (the implementation uses the built-in `node:sqlite` API)
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
```

Use the same `AGENTDOCK_DB` value on later invocations to reopen and inspect persisted data.

## Development

```bash
npm run typecheck
npm test
```

The core is split into domain-focused modules under `src/`. Services own operations such as atomically creating a Task and its initial TaskRevision; SQLite repositories encapsulate SQL. Workflow, agent-thread, and artifact modules in V0.1 are persistence abstractions only.

## Intentionally deferred

Coding-agent execution (Codex and Claude), process runners, Git worktrees, workflow execution, schedulers, Telegram, Feishu/Lark, GitHub integration, Redis, and a web dashboard belong to future roadmap milestones. In particular, Git worktree lifecycle begins in V0.2; V0.1 stores only the fields required for that future boundary.
