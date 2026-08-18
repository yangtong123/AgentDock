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

All roadmap milestones through **V1.0 — Stable Daily Driver** are implemented (see `docs/ROADMAP.md`). The project is in V1.0 stabilization and release wrap-up: bug fixes, CI, end-to-end acceptance, and the release checklist.

Post-V1.0 features (web dashboard, additional IM adapters, multi-machine workers, etc.) are out of scope until real-world usage feedback justifies them.
