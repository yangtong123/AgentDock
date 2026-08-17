import type { Database } from "../db/database.js";
import type { Application } from "../app/application.js";
import type { ImAdapter, ImCommand, ImReply } from "./im-adapter.js";
import { parseCommand } from "./command-parser.js";
import { AuditLog } from "../security/permissions.js";
import type { Orchestrator } from "../reliability/orchestrator.js";

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
  private notifier: { subscribe(conversationId: string, taskId: string): void } | null = null;
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
  attachNotifier(notifier: { subscribe(conversationId: string, taskId: string): void }): void { this.notifier = notifier; }

  private trackTaskInterest(conversationId: string, taskId: string): void { this.notifier?.subscribe(conversationId, taskId); }

  register(adapter: ImAdapter): void {
    adapter.onMessage(async (message) => {
      const command = parseCommand(message.conversationId, message.text);
      if (command) await this.handle(command, adapter.name);
    });
    adapter.onAction(async (command) => { await this.handle(command, adapter.name); });
    this.adapters.set(adapter.name, adapter);
  }

  /** Remembers which adapter a conversation came from (notifications route back through it). */
  private rememberConversationAdapter(conversationId: string, adapterName: string): void {
    this.db.prepare(`INSERT INTO im_conversations (conversation_id, adapter, project_id, focused_task_id, updated_at) VALUES (?, 'origin', NULL, NULL, ?)
      ON CONFLICT (conversation_id, adapter) DO NOTHING`).run(conversationId, this.now());
    this.conversationOrigins.set(conversationId, adapterName);
  }

  /** Outbox dispatcher entry point: push a notification to the conversation's adapter. */
  async notify(conversationId: string, text: string): Promise<void> {
    const origin = this.conversationOrigins.get(conversationId);
    const adapter = origin !== undefined ? this.adapters.get(origin) : undefined;
    if (adapter !== undefined) { await adapter.send({ conversationId, text }); return; }
    // Unknown origin (pre-restart conversation): try every adapter; wrong-platform sends fail silently.
    for (const candidate of this.adapters.values()) await candidate.send({ conversationId, text }).catch(() => undefined);
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.stop()));
  }

  /** handle() with no adapter routes to every adapter (used by tests and internal callers). */
  async handle(command: ImCommand, originAdapter?: string): Promise<ImReply> {
    const taskId = "taskId" in command ? command.taskId : undefined;
    const entry: { actor: string; action: string; detail: Record<string, unknown> } & { taskId?: string } = { actor: command.conversationId, action: command.type, detail: { originAdapter: originAdapter ?? "internal" } };
    if (taskId !== undefined) entry.taskId = taskId;
    this.audit.record(entry);
    if (originAdapter !== undefined) this.rememberConversationAdapter(command.conversationId, originAdapter);
    const reply = await this.dispatch(command);
    if (originAdapter !== undefined) {
      const adapter = this.adapters.get(originAdapter);
      if (adapter) await adapter.send(reply);
    } else {
      for (const adapter of this.adapters.values()) await adapter.send(reply);
    }
    return reply;
  }

  private async dispatch(command: ImCommand): Promise<ImReply> {
    const respond = (text: string, actions?: ImReply["actions"]): ImReply => (actions === undefined ? { conversationId: command.conversationId, text } : { conversationId: command.conversationId, text, actions });
    try {
      switch (command.type) {
        case "LIST_PROJECTS": {
          const projects = this.app.projects.list();
          return respond(projects.length === 0 ? "No projects registered." : projects.map((p) => `${p.status === "ACTIVE" ? "●" : "○"} ${p.name}`).join("\n"));
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
          const { task } = this.app.tasks.create(projectId, command.request);
          return respond(`Task created: ${task.id}\nStart it with /run ${task.id} fast|cross-review|careful`);
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
            await this.app.worktrees.prepare(command.taskId);
            const started = await this.app.workflows.start({ taskId: command.taskId, preset: command.preset });
            if (this.orchestrator !== null) {
              // Production path: the orchestrator executes under lease/concurrency and notifies via outbox.
              this.trackTaskInterest(command.conversationId, command.taskId);
              this.orchestrator.queue.enqueue(command.taskId);
              return respond(`Run ${started.run.id} queued.`);
            }
            const status = await this.app.workflows.execute(started.run.id);
            return respond(status.awaitingApproval
              ? `Run ${started.run.id} paused for your approval.`
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
            return respond(`Task ${command.taskId} (${details.task.state}) is awaiting your approval.`, [
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
            if (this.orchestrator !== null) {
              // Real cancellation: kill the task's process tree, then mark cancelled.
              this.orchestrator.requestCancel(command.taskId);
            }
            this.app.workflows.cancel(run.run.id);
            return respond(`Task ${command.taskId} stopped (run ${run.run.id} cancelled).`);
          }
          return respond(`Task ${command.taskId} is ${task.state}; nothing to stop.`);
        }
        case "APPROVE_RUN": {
          this.app.workflows.approve(command.runId, command.approved);
          if (!command.approved) return respond("Rejected. The workflow is cancelled.");
          // Resumed execution goes through the orchestrator like any other run:
          // lease, concurrency gates, task timeout, and crash recovery all apply.
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

  /** Resumes an approved/paused run: enqueued under the orchestrator when attached. */
  private resumeRun(runId: string, conversationId?: string): string {
    const taskId = this.taskIdForRun(runId);
    if (taskId !== null && this.orchestrator !== null) {
      if (conversationId !== undefined) this.trackTaskInterest(conversationId, taskId);
      this.orchestrator.queue.enqueue(taskId);
      return `Run ${runId} resumed: queued for the orchestrator.`;
    }
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
