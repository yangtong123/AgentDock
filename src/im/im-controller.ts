import type { Database } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import type { Application } from "../app/application.js";
import type { ImAdapter, ImCommand, ImReply } from "./im-adapter.js";
import { parseCommand } from "./command-parser.js";
import { AuditLog } from "../security/permissions.js";
import type { Orchestrator } from "../reliability/orchestrator.js";
import { TaskQueue } from "../reliability/task-queue.js";
import { TransactionalOutbox } from "../reliability/outbox.js";
import { ACTIVITY_EVENTS } from "../activity/activity-log.js";
import { approveRun, cancelRun, createTask, validateProviderAssignment, type CommandContext } from "../commands/task-commands.js";
import { DEFAULT_PROVIDERS, type ProviderAssignment } from "../workflows/presets.js";
import type { TaskDetails } from "../shared/domain.js";

/**
 * Domain-level controller shared by every IM adapter (Telegram now, Feishu
 * later). IM input becomes ImCommands; this is the only place those touch
 * domain services. Replies route back through the originating adapter only —
 * cross-IM visibility comes from the shared durable task state, not from
 * broadcasting chat ids across platforms. Every command lands in the audit
 * log. When an Orchestrator is attached, task execution goes through its
 * queue (leases, concurrency, cancellation) instead of running inline.
 */
export class ImController {
  private readonly adapters = new Map<string, ImAdapter>();
  private readonly audit: AuditLog;
  private orchestrator: Orchestrator | null = null;
  private notifier: { subscribe(conversationId: string, taskId: string, adapter: string | null): void } | null = null;
  private readonly conversationOrigins = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly app: Application,
    private readonly now = () => new Date().toISOString(),
  ) {
    this.audit = new AuditLog(db, now);
  }

  /** Attach the orchestrator so runs execute under leases/concurrency, not inline. */
  attachOrchestrator(orchestrator: Orchestrator): void { this.orchestrator = orchestrator; }

  /** Outbox dispatcher: terminal run events notify the conversation that started them. */
  attachNotifier(notifier: { subscribe(conversationId: string, taskId: string, adapter: string | null): void }): void { this.notifier = notifier; }

  private trackTaskInterest(conversationId: string, taskId: string, adapter: string | null): void { this.notifier?.subscribe(conversationId, taskId, adapter); }

  register(adapter: ImAdapter): void {
    adapter.onMessage(async (message) => {
      const command = parseCommand(message.conversationId, message.text);
      if (command) { await this.handle(command, adapter.name); return; }
      // A malformed /run must not be silently dropped: reply with usage.
      if (message.text.trim().startsWith("/run")) {
        await adapter.send({
          conversationId: message.conversationId,
          text: "Usage: /run TASK_ID PRESET [STEP=provider ...]\nPresets: fast, cross-review, careful, fix\nSteps (uppercase, no duplicates): PLAN IMPLEMENT VERIFY REVIEW FIX FINAL_REVIEW\nExample: /run abc123 cross-review IMPLEMENT=claude REVIEW=codex",
        });
      }
    });
    adapter.onAction(async (command) => { await this.handle(command, adapter.name); });
    this.adapters.set(adapter.name, adapter);
  }

  /** Remembers which adapter a conversation came from, durably (survives restarts).
   *  Keyed on the real adapter name: telegram and feishu rows coexist even
   *  when both platforms use the same conversationId. */
  private rememberConversationAdapter(conversationId: string, adapterName: string): void {
    this.db.prepare(`INSERT INTO im_conversation_origins (conversation_id, adapter, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (conversation_id, adapter) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(conversationId, adapterName, this.now());
    this.conversationOrigins.set(conversationId, adapterName);
  }

  /** Resolves the adapter a conversation belongs to: memory first, then the durable row. */
  private originAdapterOf(conversationId: string): string | undefined {
    const memory = this.conversationOrigins.get(conversationId);
    if (memory !== undefined) return memory;
    const row = this.db.prepare("SELECT adapter FROM im_conversation_origins WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1").get(conversationId) as { adapter: string } | undefined;
    if (row?.adapter != null) {
      this.conversationOrigins.set(conversationId, row.adapter);
      return row.adapter;
    }
    return undefined;
  }

  /** Outbox dispatcher entry point: push a notification to the conversation's adapter. */
  async notify(conversationId: string, text: string, adapterHint: string | null = null): Promise<void> {
    // The subscription's adapter hint wins: same conversationId on two
    // platforms must never receive each other's notifications. Legacy rows
    // (adapter '') resolve through the durable origin record.
    const origin = adapterHint ?? this.originAdapterOf(conversationId) ?? null;
    const adapter = origin !== null ? this.adapters.get(origin) : undefined;
    if (adapter !== undefined) { await adapter.send({ conversationId, text }); return; }
    // Never broadcast to every adapter: an unknown conversation/adapter must be
    // dropped, not leaked across identities (cross-channel rule 5).
    console.error(`[agentdock] no known adapter for conversation ${conversationId}; notification dropped`);
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.stop()));
  }

  /** Command context for shared handlers: the IM surface is one client of the
   *  same command path as CLI and the gateway. */
  private commands(): CommandContext {
    return {
      db: this.db,
      app: this.app,
      queue: this.orchestrator?.queue ?? new TaskQueue(this.db),
      outbox: new TransactionalOutbox(this.db),
      activity: this.app.activity,
      audit: this.audit,
      ...(this.orchestrator !== null ? { orchestrator: this.orchestrator } : {}),
    };
  }

  /** handle() with no adapter routes to every adapter (used by tests and internal callers). */
  async handle(command: ImCommand, originAdapter?: string): Promise<ImReply> {
    const taskId = "taskId" in command ? command.taskId : undefined;
    // Actor is the surface (telegram/feishu), not the chat id; the conversation
    // id travels in the audit detail.
    const actor = originAdapter ?? "internal";
    const entry: { actor: string; action: string; detail: Record<string, unknown> } & { taskId?: string } = { actor, action: command.type, detail: { originAdapter: originAdapter ?? "internal", conversationId: command.conversationId } };
    if ("runId" in command) entry.detail.runId = command.runId;
    if (taskId !== undefined) entry.taskId = taskId;
    this.audit.record(entry);
    if (originAdapter !== undefined) this.rememberConversationAdapter(command.conversationId, originAdapter);
    const reply = await this.dispatch(command, actor);
    if (originAdapter !== undefined) {
      const adapter = this.adapters.get(originAdapter);
      if (adapter) await adapter.send(reply);
    } else {
      for (const adapter of this.adapters.values()) await adapter.send(reply);
    }
    return reply;
  }

  private async dispatch(command: ImCommand, actor: string): Promise<ImReply> {
    const respond = (text: string, actions?: ImReply["actions"]): ImReply => (actions === undefined ? { conversationId: command.conversationId, text } : { conversationId: command.conversationId, text, actions });
    try {
      switch (command.type) {
        case "LIST_PROJECTS": {
          const projects = this.app.projects.list();
          return respond(projects.length === 0 ? "No projects registered." : projects.map((p) => `${p.status === "ACTIVE" ? "●" : "○"} ${p.name}`).join("\n"));
        }
        case "LIST_PROVIDERS": {
          const providers = Object.keys(this.app.agents);
          const defaults = Object.entries(DEFAULT_PROVIDERS).map(([step, provider]) => `${step}=${provider}`).join(" ");
          return respond(`Providers: ${providers.join(", ")}\nDefaults: ${defaults}\nAssign per run: /run TASK_ID PRESET STEP=provider ...`);
        }
        case "USE_PROJECT": {
          const project = this.app.projects.list().find((p) => p.name === command.projectName);
          if (!project) return respond(`Unknown project: ${command.projectName}`);
          this.saveFocus(command.conversationId, project.id);
          return respond(`Using project ${project.name}.`);
        }
        case "CREATE_TASK": {
          const projectId = this.focus(command.conversationId);
          if (!projectId) return respond("Select a project first with /use NAME.");
          const details = await createTask(
            this.commands(),
            { projectId, request: command.request, actor },
          ) as TaskDetails;
          return respond(`Task created: ${details.task.id}\nStart it with /run ${details.task.id} fast|cross-review|careful`);
        }
        case "LIST_TASKS": {
          const projectId = this.focus(command.conversationId);
          if (!projectId) return respond("Select a project first with /use NAME.");
          const tasks = this.app.tasks.list(projectId);
          return respond(tasks.length === 0 ? "No tasks." : tasks.map((t) => `${t.state} ${t.id}`).join("\n"));
        }
        case "RUN_TASK": {
          const projectId = this.focus(command.conversationId);
          if (!projectId) return respond("Select a project first with /use NAME.");
          try {
            // Provider names validate against the registered agents (parser already
            // validated step types); the error lists the valid values.
            const providers = (command.providers ?? {}) as ProviderAssignment;
            validateProviderAssignment(Object.keys(this.app.agents), providers);
            const startInput = { taskId: command.taskId, preset: command.preset, providers };
            await this.app.worktrees.prepare(command.taskId);
            if (this.orchestrator !== null) {
              // Production path: the orchestrator executes under lease/concurrency and notifies via outbox.
              // Start + subscribe + enqueue commit as one operation: recovery
              // must never see a QUEUED run without its queue entry.
              const started = withImmediateTransaction(this.db, () => {
                const s = this.app.workflows.start(startInput);
                this.trackTaskInterest(command.conversationId, command.taskId, this.originAdapterOf(command.conversationId) ?? null);
                this.orchestrator!.queue.enqueue(command.taskId);
                this.app.activity.record({ type: ACTIVITY_EVENTS.runQueued, taskId: command.taskId, runId: s.run.id, actor, payload: { preset: command.preset, ...(Object.keys(providers).length > 0 ? { providers } : {}) } });
                return s;
              });
              this.audit.record({ actor, action: "run.start", taskId: command.taskId, detail: { runId: started.run.id, preset: command.preset } });
              return respond(`Run ${started.run.id} queued.`);
            }
            const started = this.app.workflows.start(startInput);
            this.audit.record({ actor, action: "run.start", taskId: command.taskId, detail: { runId: started.run.id, preset: command.preset } });
            const status = await this.app.workflows.execute(started.run.id);
            return respond(status.awaitingApproval
              ? `Run ${started.run.id} paused for your approval.\n/approve ${started.run.id} or /reject ${started.run.id}`
              : `Run ${started.run.id} finished: ${status.run.state}.`, status.awaitingApproval ? [
                { label: "Approve", command: { type: "APPROVE_RUN", conversationId: command.conversationId, runId: started.run.id, approved: true } },
                { label: "Reject", command: { type: "APPROVE_RUN", conversationId: command.conversationId, runId: started.run.id, approved: false } },
              ] : undefined);
          } catch (error) {
            return respond(`Error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        case "TASK_STATUS": {
          const details = this.app.tasks.show(command.taskId);
          const run = this.activeRunFor(command.taskId);
          if (run?.awaitingApproval) {
            return respond(`Task ${command.taskId} (${details.task.state}) is awaiting your approval — run ${run.run.id}.\n/approve ${run.run.id} or /reject ${run.run.id}`, [
              { label: "Approve", command: { type: "APPROVE_RUN", conversationId: command.conversationId, runId: run.run.id, approved: true } },
              { label: "Reject", command: { type: "APPROVE_RUN", conversationId: command.conversationId, runId: run.run.id, approved: false } },
            ]);
          }
          if (run && run.run.state === "RUNNING" && run.steps.some((s) => s.state === "RUNNING" && s.stepType === "HUMAN_APPROVAL")) {
            return respond(`Task ${command.taskId} is paused at an approval gate.`);
          }
          return respond(`Task ${command.taskId}: ${details.task.state}${run ? `\nRun ${run.run.id}: ${run.run.state}` : ""}`);
        }
        case "STOP_TASK": {
          const task = this.app.tasks.list().find((t) => t.id === command.taskId);
          if (!task) return respond(`Unknown task: ${command.taskId}`);
          const run = this.activeRunFor(command.taskId);
          if (run) {
            // Shared handler: engine cancel + process kill + run.cancelled notification.
            await cancelRun(this.commands(), { runId: run.run.id, actor });
            return respond(`Task ${command.taskId} stopped (run ${run.run.id} cancelled).`);
          }
          return respond(`Task ${command.taskId} is ${task.state}; nothing to stop.`);
        }
        case "WATCH_TASK": {
          const task = this.app.tasks.list().find((t) => t.id === command.taskId);
          if (!task) return respond(`Unknown task: ${command.taskId}`);
          this.trackTaskInterest(command.conversationId, task.id, this.originAdapterOf(command.conversationId) ?? null);
          const run = this.activeRunFor(command.taskId);
          return respond(`Subscribed to task ${task.id} (${task.state})${run ? ` · run ${run.run.id} (${run.run.state})` : ""}. Notifications will be delivered to this conversation.`);
        }
        case "APPROVE_RUN": {
          if (!command.approved) {
            // Reject goes through the shared command handler: audit + activity included.
            await approveRun(this.commands(), { runId: command.runId, approved: false, actor });
            return respond(`Rejected. The workflow is cancelled (run ${command.runId}).`);
          }
          if (this.orchestrator !== null) {
            // Shared handler: approve + re-enqueue commit atomically. The
            // subscription follows immediately — it is notification routing,
            // not part of the recovery invariant (start+enqueue).
            await approveRun(this.commands(), { runId: command.runId, approved: true, actor });
            const taskId = this.taskIdForRun(command.runId);
            if (taskId !== null) {
              this.trackTaskInterest(command.conversationId, taskId, this.originAdapterOf(command.conversationId) ?? null);
              return respond(`Run ${command.runId} resumed: queued for the orchestrator.`);
            }
            return respond(`Run ${command.runId} resumed.`);
          }
          // No orchestrator (tests, CLI-driven usage): approve inline, resume inline.
          this.app.workflows.approve(command.runId, true, { actor });
          return respond(this.resumeRun(command.runId, command.conversationId));
        }
        case "CONTINUE_RUN": {
          return respond(this.resumeRun(command.runId, command.conversationId));
        }
        case "VIEW_DIFF": {
          const diff = await this.app.worktrees.diff(command.taskId, { stat: command.statOnly });
          return respond(diff === "" ? "No changes." : (diff.length > 3500 ? `${diff.slice(0, 3500)}\n… (truncated, use --stat)` : diff));
        }
        default:
          return respond("Unsupported command.");
      }
    } catch (error) {
      return respond(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activeRunFor(taskId: string): ReturnType<Application["workflows"]["status"]> | null {
    const runs = this.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?) ORDER BY created_at DESC, id DESC`).all(taskId) as { id: string }[];
    for (const { id } of runs) {
      const status = this.app.workflows.status(id);
      if (status.run.state !== "SUCCEEDED" && status.run.state !== "FAILED" && status.run.state !== "CANCELLED") return status;
    }
    return null;
  }

  /**
   * Enqueues a paused run for the attached orchestrator. Callers that also
   * mutate run/task state (e.g. approving a gate) must wrap both in one
   * withImmediateTransaction: recovery classifies from durable state and must
   * never observe the transition without its queue entry.
   */
  private enqueueResume(runId: string, conversationId?: string): string {
    const taskId = this.taskIdForRun(runId);
    if (taskId === null) return `Run ${runId} resumed.`;
    if (conversationId !== undefined) this.trackTaskInterest(conversationId, taskId, this.originAdapterOf(conversationId) ?? null);
    this.orchestrator!.queue.enqueue(taskId);
    return `Run ${runId} resumed: queued for the orchestrator.`;
  }

  /** Resumes an approved/paused run: enqueued under the orchestrator when attached. */
  private resumeRun(runId: string, conversationId?: string): string {
    const taskId = this.taskIdForRun(runId);
    if (taskId !== null && this.orchestrator !== null) return this.enqueueResume(runId, conversationId);
    if (taskId === null) return `Run ${runId} resumed.`;
    // No orchestrator (tests, CLI-driven usage): execute inline as before.
    void this.app.workflows.execute(runId).catch(() => undefined);
    return `Run ${runId} resumed.`;
  }

  private taskIdForRun(runId: string): string | null {
    const row = this.db.prepare(`SELECT tr.task_id AS taskId FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE wr.id = ?`).get(runId) as { taskId: string } | undefined;
    return row?.taskId ?? null;
  }

  private focus(conversationId: string): string | null {
    const row = this.db.prepare("SELECT project_id FROM im_conversations WHERE conversation_id = ?").get(conversationId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  }

  private saveFocus(conversationId: string, projectId: string): void {
    const timestamp = this.now();
    this.db.prepare(`INSERT INTO im_conversations (conversation_id, adapter, project_id, focused_task_id, updated_at) VALUES (?, 'global', ?, NULL, ?)
      ON CONFLICT (conversation_id, adapter) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`).run(conversationId, projectId, timestamp);
  }
}
