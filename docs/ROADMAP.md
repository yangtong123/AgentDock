# AgentDock Roadmap

AgentDock is developed as a sequence of vertical, independently testable milestones. Each version should be usable and verifiable before later functionality is added.

## V0.1 — Core Foundation

Goal: establish the durable domain model and persistence boundaries.

Implement:
- Node.js + TypeScript application skeleton
- SQLite database and migrations
- Project
- Task
- TaskRevision
- WorkflowRun
- StepRun
- AgentThread
- Artifact
- repository/service boundaries
- minimal local CLI for creating/listing Projects and Tasks

Do not implement agents, Telegram, Git worktrees, or GitHub integration yet.

Acceptance: start the app, migrate the DB, create a Project and Task, restart, and confirm data persists.

## V0.2 — Multi-project + Git Worktree

Goal: isolate multiple tasks across multiple managed repositories.

Implement Project registry behavior, GitService, WorktreeManager, branch/worktree lifecycle, git status/diff/stat/SHA, and cleanup.

Acceptance: multiple tasks in the same project and tasks in different projects have isolated working directories.

## V0.3 — Agent Runtime

Goal: run Claude Code or Codex against a task worktree through a provider-neutral abstraction.

Implement ProcessRunner, CodingAgent, ClaudeAgent, CodexAgent, AgentThread start/resume, timeout basics, and stdout/stderr artifacts.

Acceptance: either agent can modify only its task worktree and session loss can fall back to durable task context.

## V0.4 — Workflow Engine

Goal: make AgentDock a real coding-agent orchestrator.

Implement workflow definitions and step execution for PLAN, IMPLEMENT, VERIFY, REVIEW, FIX, FINAL_REVIEW, and HUMAN_APPROVAL.

Initial presets:
- Fast: IMPLEMENT -> VERIFY
- Cross Review: IMPLEMENT -> VERIFY -> REVIEW -> FIX -> VERIFY -> FINAL_REVIEW
- Careful: PLAN -> HUMAN_APPROVAL -> IMPLEMENT -> VERIFY -> REVIEW -> FIX -> VERIFY -> FINAL_REVIEW -> HUMAN_APPROVAL

Providers must be configurable per step.

## V0.5 — Telegram

Goal: control tasks from a phone without SSH.

Implement IMAdapter and TelegramAdapter with `/projects`, `/use`, `/new`, `/tasks`, `/status`, `/stop` and interactive actions for plan approval, diff/review viewing, continuation, and stop.

Telegram handlers only create domain commands; they do not directly execute agents or arbitrary shell commands.

## V0.6 — Agent Collaboration

Goal: make Claude/Codex combinations and review/fix loops robust.

Implement arbitrary provider combinations, session resume/fresh policies, session-loss fallback, structured review findings, bounded review/fix loops, and maxReviewRounds.

## V0.7 — Reliability

Goal: safely run AgentDock continuously.

Implement command idempotency, worker leases, heartbeats, transactional outbox, real process-tree cancellation, step/task timeouts, global/project concurrency, scheduling, project pause/disable, priority, orphan detection, and crash recovery.

## V0.8 — GitHub

Goal: connect completed tasks to the normal software delivery lifecycle.

Implement branch push, Draft PR creation, PR/CI status, CI failure ingestion, FIX workflow for CI failures, and PR review feedback ingestion.

Do not auto-merge in this version.

## V0.9 — Security + Observability

Goal: make the system appropriate for regular internal use.

Implement controlled agent environments, permission profiles, secret isolation, audit logs, execution metrics, duration/usage tracking, review/verification statistics, and resource/budget controls.

## V1.0 — Stable Daily Driver

V1.0 formally supports:
- multiple projects and tasks
- Claude Code and Codex as interchangeable providers
- Fast, Cross Review, Careful, and custom workflows
- Git worktrees and session resume
- deterministic verification and bounded review/fix loops
- human approval gates
- Telegram
- Feishu / Lark
- local CLI
- crash recovery, cancellation, concurrency control
- GitHub Draft PR and CI feedback
- audit, security, budget/resource controls, and metrics

Feishu/Lark must use the same domain-level control model as Telegram. Tasks belong to AgentDock, not to a specific IM conversation. A task created through Telegram must be visible and controllable through Feishu/Lark, and vice versa.

## After V1.0

Potential later additions include a web dashboard, Slack/Discord adapters, multi-machine workers, stronger container isolation, automatic complexity routing, more coding-agent providers, task dependency DAGs, scheduled work, team RBAC, and multi-tenancy.
