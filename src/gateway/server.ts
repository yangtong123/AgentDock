import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../db/database.js";
import type { Application } from "../app/application.js";
import type { TaskQueue } from "../reliability/task-queue.js";
import { NotFoundError, StateConflictError, ValidationError, TASK_STATES, RUN_STATES } from "../shared/domain.js";
import { DEFAULT_PROVIDERS, expandPreset } from "../workflows/presets.js";
import { approveRun, cancelRun, createTask, isReplayed, prepareTask, retryRun, reviseTask, startRun, type CommandContext } from "../commands/task-commands.js";
import { checkToken, resolveGatewayToken } from "./auth.js";
import { asBoolean, asEnum, asInt, asOptionalString, asProviders, asString } from "./validate.js";
import { SseManager } from "./sse.js";
import { TransactionalOutbox } from "../reliability/outbox.js";

export interface GatewayDeps {
  db: Database;
  app: Application;
  queue: TaskQueue;
  orchestrator?: { requestCancel(taskId: string): void };
  host: string;
  port: number;
  /** Explicit token; resolved from env/file via auth.ts when omitted. */
  token?: string;
  /** Database path used to locate the token file when token is omitted. */
  dbPath?: string;
  /** SSE poll interval (tests inject a tight one). */
  ssePollIntervalMs?: number;
  /** Workbench static root; defaults to <repo>/workbench/dist relative to this module. */
  workbenchDir?: string;
}

export interface Gateway {
  start(): Promise<{ url: string; token: string; tokenSource: string }>;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const PRESETS = ["fast", "cross-review", "careful", "fix"] as const;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_WORKBENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../workbench/dist");
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ValidationError(`request body too large (max ${MAX_BODY_BYTES} bytes)`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ValidationError("request body must be valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Backs `end` off to a UTF-8 boundary: a chunk must never split a multi-byte character. */
function utf8SafeEnd(buffer: Buffer, end: number): number {
  let cut = end;
  while (cut > 0) {
    const byte = buffer[cut - 1]!;
    if ((byte & 0x80) === 0) return end; // ASCII tail: the cut is clean
    if ((byte & 0xc0) === 0x80) { cut--; continue; } // continuation byte: keep walking to the lead
    // Lead byte at cut-1: drop the sequence when it continues past the cut.
    const expected = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
    return end - (cut - 1) < expected ? cut - 1 : end;
  }
  return end;
}

function readRange(path: string, offset: number, limit: number): { data: string; nextOffset: number; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.max(0, Math.min(limit, size - offset));
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    // nextOffset stays on a char boundary, so the following read continues mid-character-free.
    let safeEnd = utf8SafeEnd(buffer, length);
    if (safeEnd === 0 && length > 0) safeEnd = length; // limit smaller than one char: never stall the cursor
    return { data: buffer.subarray(0, safeEnd).toString("utf8"), nextOffset: offset + safeEnd, size };
  } finally { closeSync(fd); }
}

/**
 * Local HTTP gateway for the workbench. Same durable domain state the CLI/IM
 * use, exposed read-only over GET and mutated through the shared command
 * layer. Loopback-only by default, bearer-token auth, no CORS allowance.
 */
export function createGateway(deps: GatewayDeps): Gateway {
  const { db, app } = deps;
  const commands: CommandContext = {
    db,
    app,
    queue: deps.queue,
    outbox: new TransactionalOutbox(db),
    activity: app.activity,
    audit: app.audit,
    ...(deps.orchestrator !== undefined ? { orchestrator: deps.orchestrator } : {}),
  };
  const resolved = deps.token !== undefined
    ? { token: deps.token, source: "explicit" }
    : resolveGatewayToken(deps.dbPath ?? ":memory:");
  const sse = new SseManager(app.activity, deps.ssePollIntervalMs ?? 250);
  let server: Server | null = null;
  let actualPort = deps.port;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", ...headers });
    res.end(JSON.stringify(body));
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string): void => send(res, status, { error: { code, message } });

  const requireIdempotencyKey = (req: IncomingMessage): string => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") throw new ValidationError("Idempotency-Key header is required");
    return key;
  };

  /** Replayed idempotent commands return their stored response under the replay header. */
  const sendCommandResult = (res: ServerResponse, result: unknown): void => {
    if (isReplayed(result)) send(res, 200, result.response, { "idempotency-replayed": "true" });
    else send(res, 200, result);
  };

  const requireTask = (taskId: string): void => {
    if (app.repositories.tasks.findById(taskId) === undefined) throw new NotFoundError(`Task ${taskId} not found`);
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> => {
    const method = req.method ?? "GET";
    const query = url.searchParams;
    if (method === "GET" && segments.length === 2 && segments[1] === "projects") return send(res, 200, app.projects.list());
    if (method === "GET" && segments.length === 2 && segments[1] === "providers") return send(res, 200, Object.keys(app.agents));
    if (method === "GET" && segments.length === 2 && segments[1] === "workflow-presets") {
      return send(res, 200, { presets: PRESETS.map((name) => ({ name, steps: expandPreset(name) })), defaultProviders: DEFAULT_PROVIDERS });
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "tasks") {
      const projectId = asOptionalString(query.get("projectId"), "projectId");
      const state = query.get("state") === null ? undefined : asEnum(query.get("state"), "state", TASK_STATES);
      const tasks = app.tasks.list(projectId);
      const filtered = state === undefined ? tasks : tasks.filter((task) => task.state === state);
      // The list view needs attention state without N+1 detail calls.
      const latestRunStatement = db.prepare("SELECT wr.id AS id FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ? ORDER BY wr.created_at DESC, wr.id DESC LIMIT 1");
      const findingsStatement = db.prepare("SELECT 1 AS x FROM artifacts WHERE task_id = ? AND kind = 'review-findings' LIMIT 1");
      return send(res, 200, filtered.map((task) => {
        const row = latestRunStatement.get(task.id) as { id: string } | undefined;
        const hasReviewFindings = findingsStatement.get(task.id) !== undefined;
        if (row === undefined) return { ...task, latestRun: null, hasReviewFindings };
        const status = app.workflows.status(row.id);
        return { ...task, latestRun: { id: status.run.id, state: status.run.state, preset: status.run.preset, awaitingApproval: status.awaitingApproval }, hasReviewFindings };
      }));
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "tasks") {
      const taskId = segments[2]!;
      const details = app.tasks.show(taskId);
      const runs = (db.prepare("SELECT wr.id AS id FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ? ORDER BY wr.created_at, wr.id").all(taskId) as { id: string }[])
        .map((row) => app.workflows.status(row.id));
      return send(res, 200, { ...details, runs });
    }
    if (method === "GET" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "diff") {
      const taskId = segments[2]!;
      requireTask(taskId);
      const stat = query.get("stat") === null ? false : asBoolean(query.get("stat"), "stat");
      const maxBytes = query.get("maxBytes") === null ? undefined : asInt(query.get("maxBytes"), "maxBytes", { min: 1, max: 1024 * 1024 });
      const diff = await app.worktrees.diff(taskId, { stat });
      const totalBytes = Buffer.byteLength(diff, "utf8");
      // Large diffs are measured in full but sent capped; the UI shows a notice.
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        const buffer = Buffer.from(diff, "utf8");
        return send(res, 200, { diff: buffer.subarray(0, utf8SafeEnd(buffer, maxBytes)).toString("utf8"), truncated: true, totalBytes });
      }
      return send(res, 200, { diff, truncated: false, totalBytes });
    }
    if (method === "GET" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "artifacts") {
      const taskId = segments[2]!;
      requireTask(taskId);
      return send(res, 200, app.repositories.artifacts.listForTask(taskId));
    }
    if (method === "GET" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "activity") {
      const taskId = segments[2]!;
      requireTask(taskId);
      const limit = query.get("limit") === null ? 100 : asInt(query.get("limit"), "limit", { min: 1, max: 200 });
      return send(res, 200, app.activity.listForTask(taskId, limit));
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "runs") {
      const runId = segments[2]!;
      const status = app.workflows.status(runId);
      const durations = new Map((db.prepare("SELECT step_run_id AS id, duration_ms AS ms FROM step_durations WHERE step_run_id IN (SELECT id FROM step_runs WHERE workflow_run_id = ?)").all(runId) as { id: string; ms: number }[]).map((row) => [row.id, row.ms]));
      // Review round derives from durable REVIEW steps (the engine's own rule):
      // REVIEW/FINAL_REVIEW open a new round; FIX addresses the completed one.
      const completedReviews = (sequence: number): number => status.steps.filter((step) => step.stepType === "REVIEW" && step.state === "SUCCEEDED" && step.sequence < sequence).length;
      return send(res, 200, {
        ...status,
        steps: status.steps.map((step) => ({
          ...step,
          durationMs: durations.get(step.id) ?? null,
          reviewRound: step.stepType === "REVIEW" || step.stepType === "FINAL_REVIEW"
            ? completedReviews(step.sequence) + 1
            : step.stepType === "FIX" ? Math.max(1, completedReviews(step.sequence)) : null,
        })),
      });
    }
    if (method === "GET" && segments.length === 4 && segments[1] === "steps" && segments[3] === "log") {
      const stepRunId = segments[2]!;
      const step = db.prepare("SELECT id FROM step_runs WHERE id = ?").get(stepRunId);
      if (step === undefined) throw new NotFoundError(`StepRun ${stepRunId} not found`);
      const stream = query.get("stream") === null ? "stdout" : asEnum(query.get("stream"), "stream", ["stdout", "stderr"] as const);
      const offset = query.get("offset") === null ? 0 : asInt(query.get("offset"), "offset", { min: 0 });
      const limit = query.get("limit") === null ? 65_536 : asInt(query.get("limit"), "limit", { min: 1, max: 262_144 });
      const artifact = db.prepare("SELECT storage_type, path FROM artifacts WHERE step_run_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(stepRunId, stream === "stdout" ? "agent-stdout" : "agent-stderr") as { storage_type: string; path: string | null } | undefined;
      // Step not started (or no log captured): an empty, still-growing stream.
      if (artifact === undefined) return send(res, 200, { offset: 0, nextOffset: 0, data: "", complete: false });
      if (artifact.storage_type !== "FILE" || artifact.path === null || !existsSync(artifact.path)) throw new NotFoundError(`log file for step ${stepRunId} not found`);
      const range = readRange(artifact.path, offset, limit);
      return send(res, 200, { offset, nextOffset: range.nextOffset, data: range.data, complete: range.nextOffset >= range.size });
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "events") {
      const header = req.headers["last-event-id"];
      const lastEventId = query.get("lastEventId") !== null
        ? asInt(query.get("lastEventId"), "lastEventId", { min: 0 })
        : typeof header === "string" && header !== "" ? asInt(header, "Last-Event-ID", { min: 0 }) : 0;
      if (!sse.add(res, lastEventId)) return sendError(res, 429, "too-many-connections", "too many SSE connections");
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "tasks") {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const result = await createTask(commands, { projectId: asString(body.projectId, "projectId"), request: asString(body.request, "request"), actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "prepare") {
      const idempotencyKey = requireIdempotencyKey(req);
      await readJsonBody(req);
      const result = await prepareTask(commands, { taskId: segments[2]!, actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "revisions") {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const result = await reviseTask(commands, { taskId: segments[2]!, request: asString(body.request, "request"), actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "tasks" && segments[3] === "runs") {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const scheduledAt = asOptionalString(body.scheduledAt, "scheduledAt");
      const scheduledDate = scheduledAt === undefined ? undefined : new Date(scheduledAt);
      if (scheduledDate !== undefined && Number.isNaN(scheduledDate.getTime())) throw new ValidationError("scheduledAt must be an ISO timestamp");
      const result = await startRun(commands, {
        taskId: segments[2]!,
        preset: asString(body.preset, "preset"),
        ...(asProviders(body.providers, Object.keys(app.agents)) !== undefined ? { providers: asProviders(body.providers, Object.keys(app.agents))! } : {}),
        ...(body.maxReviewRounds !== undefined ? { maxReviewRounds: asInt(body.maxReviewRounds, "maxReviewRounds", { min: 1, max: 10 }) } : {}),
        ...(body.stepTimeoutMs !== undefined ? { stepTimeoutMs: asInt(body.stepTimeoutMs, "stepTimeoutMs", { min: 1000 }) } : {}),
        ...(body.priority !== undefined ? { priority: asInt(body.priority, "priority", { min: 1, max: 9 }) } : {}),
        ...(scheduledDate !== undefined ? { scheduledAt: scheduledDate } : {}),
        actor: "desktop",
        idempotencyKey,
      });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "runs" && (segments[3] === "approve" || segments[3] === "reject")) {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const expectedRunState = body.expectedRunState === undefined ? undefined : asEnum(body.expectedRunState, "expectedRunState", RUN_STATES);
      const result = await approveRun(commands, { runId: segments[2]!, approved: segments[3] === "approve", ...(expectedRunState !== undefined ? { expectedRunState } : {}), actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "runs" && segments[3] === "cancel") {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const expectedRunState = body.expectedRunState === undefined ? undefined : asEnum(body.expectedRunState, "expectedRunState", RUN_STATES);
      const result = await cancelRun(commands, { runId: segments[2]!, ...(expectedRunState !== undefined ? { expectedRunState } : {}), actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    if (method === "POST" && segments.length === 4 && segments[1] === "runs" && segments[3] === "retry") {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = await readJsonBody(req);
      const providers = asProviders(body.providers, Object.keys(app.agents));
      const expectedRunState = body.expectedRunState === undefined ? undefined : asEnum(body.expectedRunState, "expectedRunState", RUN_STATES);
      const result = await retryRun(commands, { runId: segments[2]!, ...(providers !== undefined ? { providers } : {}), ...(expectedRunState !== undefined ? { expectedRunState } : {}), actor: "desktop", idempotencyKey });
      return sendCommandResult(res, result);
    }
    return sendError(res, 404, "not-found", `no route for ${method} ${url.pathname}`);
  };

  /** Serves the built workbench: index at /, assets by path, SPA fallback, no auth. */
  const serveStatic = (pathname: string, res: ServerResponse): void => {
    const root = deps.workbenchDir ?? DEFAULT_WORKBENCH_DIR;
    if (!existsSync(root)) return sendError(res, 404, "not-found", "workbench is not built");
    let relative: string;
    try { relative = decodeURIComponent(pathname); } catch { return sendError(res, 400, "bad-request", "malformed path"); }
    const resolved = resolve(root, relative === "/" ? "index.html" : relative.replace(/^\/+/, ""));
    // Traversal must never escape the static root.
    if (resolved !== root && !resolved.startsWith(root + sep)) return sendError(res, 400, "bad-request", "path escapes the static root");
    let file = resolved;
    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA fallback: client-side routes are served the shell.
      file = join(root, "index.html");
      if (!existsSync(file)) return sendError(res, 404, "not-found", "workbench is not built");
    }
    const stream = createReadStream(file);
    // The file can vanish or be unreadable between statSync and open: fail the
    // request, never the process. Headers go out only once the fd is open.
    stream.on("error", () => {
      if (!res.headersSent) sendError(res, 404, "not-found", "file not readable");
      else res.destroy();
    });
    stream.on("open", () => {
      res.writeHead(200, {
        "content-type": STATIC_CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        // The shell needs same-origin fetch/EventSource; the virtualizer uses inline style attributes.
        ...(extname(file) === ".html" ? { "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" } : {}),
      });
      stream.pipe(res);
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://gateway.local");
      const segments = url.pathname.split("/").filter(Boolean);
      // The SPA shell and its assets are public; every /api route stays token-protected.
      if (segments[0] !== "api" || segments[1] !== "v1") {
        if ((req.method ?? "GET") === "GET") return serveStatic(url.pathname, res);
        return sendError(res, 404, "not-found", `no route for ${req.method ?? "GET"} ${url.pathname}`);
      }
      // Same-origin guard: an Origin header must name this very listener; no
      // CORS headers are ever emitted, so browsers cannot call cross-origin.
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let originUrl: URL;
        try { originUrl = new URL(origin); } catch { return sendError(res, 403, "forbidden-origin", "Origin is not allowed"); }
        const hostOk = LOCAL_HOSTS.has(originUrl.hostname);
        const portOk = originUrl.port === String(actualPort);
        if (!hostOk || !portOk) return sendError(res, 403, "forbidden-origin", "Origin is not allowed");
      }
      const authorization = req.headers.authorization ?? "";
      // EventSource cannot set headers: ?token= is accepted on GET /events only.
      const eventsRoute = (req.method ?? "GET") === "GET" && segments[2] === "events" && segments.length === 3;
      const presented = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : eventsRoute ? (url.searchParams.get("token") ?? "") : "";
      if (!checkToken(presented, resolved.token)) return sendError(res, 401, "unauthorized", "missing or invalid bearer token");
      await route(req, res, url, segments.slice(1));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof StateConflictError) return sendError(res, 409, "state-conflict", error.message);
      if (error instanceof NotFoundError) return sendError(res, 404, "not-found", error.message);
      if (error instanceof ValidationError) return sendError(res, 400, "validation", error.message);
      console.error(`[agentdock] gateway error: ${error instanceof Error ? error.message : String(error)}`);
      return sendError(res, 500, "internal", "internal error");
    }
  };

  return {
    async start() {
      const created = createServer((req, res) => { void handle(req, res); });
      server = created;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(deps.port, deps.host, () => resolve());
      });
      const address = created.address();
      actualPort = typeof address === "object" && address !== null ? address.port : deps.port;
      return { url: `http://${deps.host}:${actualPort}`, token: resolved.token, tokenSource: resolved.source };
    },
    async stop() {
      sse.stop();
      const running = server;
      if (running === null) return;
      server = null;
      const closed = new Promise<void>((resolve) => running.close(() => resolve()));
      // close() alone waits out lingering keep-alive/SSE sockets (seconds).
      running.closeAllConnections();
      await closed;
    },
  };
}
