# AGENTS.md

## Project

AgentDock is a multi-project coding-agent orchestrator. It coordinates coding agents such as Claude Code and Codex across multiple repositories and isolated Git worktrees.

## Core architecture principles

1. Roles and providers are decoupled. Do not hard-code Codex as planner/reviewer or Claude as implementer. Workflow steps select a provider.
2. Git and durable task artifacts are the source of truth. Agent session history is an optimization, not durable state.
3. Every development task must eventually run in an isolated Git worktree.
4. Deterministic verification (tests, typecheck, lint, static analysis) has higher authority than LLM review.
5. The top-level orchestrator owns workflow state, retries, approvals, cancellation, and scheduling. Individual coding agents do not control the global workflow.
6. User/IM input must never be concatenated into shell commands. Process execution must use argument arrays with shell disabled.
7. Agent credentials and service secrets must be isolated; do not blindly inherit the orchestrator's full environment.
8. Prefer small, explicit interfaces over speculative abstractions.

## Development discipline

- Read `docs/ROADMAP.md` before making architectural changes.
- When a task document exists under `docs/tasks/`, implement only the requested milestone.
- Do not implement future-version features unless the current task explicitly requires an interface seam for them.
- Preserve migration compatibility once persistent data exists.
- Add tests for domain behavior and state transitions.
- Keep domain logic independent from Telegram, Feishu, GitHub, Codex CLI, and Claude Code CLI implementations.
- Prefer ports/adapters around external systems.

## Current status

All roadmap milestones through **V1.0 — Stable Daily Driver** are implemented (see `docs/ROADMAP.md`).

**V1.1 — Cross-Agent Workbench** is code-complete with all real-environment acceptance runs passed (see `docs/tasks/V1.1-CROSS-AGENT-WORKBENCH.md` and `docs/tasks/v1.1-release-checklist.md`). All five milestones are implemented: the local gateway (`src/gateway/`, REST + SSE on `127.0.0.1:4173` with a Bearer token, started by `agentdock serve`), the durable activity stream (`src/activity/`), shared command handlers (`src/commands/`) used by CLI, IM, and HTTP, the browser workbench (`workbench/`, React + Vite, served by the gateway) with task composer and desktop controls, and cross-channel continuity with normalized actors. Acceptance evidence (2026-08-19): single-provider, both Claude×Codex directions, and cross-channel continuity both ways — desktop-started `careful` run approved from Feishu, Feishu-started run observed live on desktop. Remaining: release mechanics only (commit, CI green on main, README quick-start verification), plus optional hardening of two acceptance findings: `git` fails inside the macOS seatbelt write-jail (`/dev/null` not permitted), and desktop-started tasks notify no IM conversation until the first IM interaction subscribes it.
