import type { ServerResponse } from "node:http";
import type { ActivityLog } from "../activity/activity-log.js";

const MAX_CONNECTIONS = 16;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const REPLAY_LIMIT = 1000;

interface SseClient {
  res: ServerResponse;
  lastId: number;
}

/**
 * SSE over the durable activity stream. Polling is the source of truth —
 * SQLite commits are visible to any subsequent read, including events written
 * by CLI/IM processes — while ActivityLog pokes only lower in-process latency.
 * Slow clients are disconnected at the buffer cap; they never block anything.
 */
export class SseManager {
  private readonly clients = new Set<SseClient>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private offPoke: (() => void) | null = null;

  constructor(
    private readonly activity: ActivityLog,
    private readonly pollIntervalMs = 250,
    private readonly heartbeatMs = 15_000,
  ) {}

  get connectionCount(): number { return this.clients.size; }

  /** Attaches a response as an SSE stream. Returns false when the connection cap is reached. */
  add(res: ServerResponse, lastEventId: number): boolean {
    if (this.clients.size >= MAX_CONNECTIONS) return false;
    const client: SseClient = { res, lastId: lastEventId };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-content-type-options": "nosniff" });
    // With no backlog to replay, nothing would be written until the first
    // heartbeat — flush so the client sees 200 immediately.
    res.flushHeaders();
    this.clients.add(client);
    if (this.clients.size === 1) this.startTimers();
    this.flush(client);
    res.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopTimers();
    });
    return true;
  }

  stop(): void {
    this.stopTimers();
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
  }

  private startTimers(): void {
    this.pollTimer = setInterval(() => this.flushAll(), this.pollIntervalMs);
    // Comment heartbeats keep proxies and laptops from killing idle streams.
    this.heartbeatTimer = setInterval(() => { for (const client of this.clients) this.send(client, ": hb\n\n"); }, this.heartbeatMs);
    this.offPoke = this.activity.onPoke(() => this.flushAll());
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.offPoke?.();
    this.offPoke = null;
  }

  private flushAll(): void {
    for (const client of this.clients) this.flush(client);
  }

  private flush(client: SseClient): void {
    if (client.res.destroyed) { this.clients.delete(client); return; }
    const events = this.activity.listSince(client.lastId, REPLAY_LIMIT + 1);
    if (events.length === 0) return;
    if (events.length > REPLAY_LIMIT) {
      // The client fell further behind than the replay window: it must refetch
      // state, and the stream continues from the newest event.
      const latest = events[events.length - 1]!;
      this.send(client, `event: resync\ndata: ${JSON.stringify({ lastEventId: latest.id })}\n\n`);
      client.lastId = latest.id;
      return;
    }
    for (const event of events) {
      const data = JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        runId: event.workflowRunId,
        stepRunId: event.stepRunId,
        actor: event.actor,
        payload: JSON.parse(event.payload) as unknown,
        createdAt: event.createdAt,
      });
      this.send(client, `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`);
      client.lastId = event.id;
    }
  }

  private send(client: SseClient, frame: string): void {
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      client.res.destroy();
      this.clients.delete(client);
      return;
    }
    client.res.write(frame);
    // Post-write check too: one oversized frame must trip the cap, not slip through.
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      client.res.destroy();
      this.clients.delete(client);
    }
  }
}
