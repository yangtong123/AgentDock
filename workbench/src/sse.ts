import { getToken } from "./api";
import type { ActivityEvent } from "./types";

const EVENT_TYPES = [
  "task.created", "task.revised", "task.prepared", "task.cancel-requested",
  "task.succeeded", "task.failed", "task.cancelled",
  "run.queued", "run.running", "run.paused", "run.succeeded", "run.failed", "run.cancelled",
  "step.started", "step.succeeded", "step.failed", "step.cancelled",
  "approval.requested", "approval.decided",
  "review.completed", "verify.completed", "artifact.created",
];

export interface LiveEvent extends ActivityEvent {
  payload: unknown;
}

/**
 * One EventSource over /api/v1/events. Reconnect is built into EventSource —
 * it resends the last received event id as Last-Event-ID and the gateway
 * replays from there; a `resync` frame means we fell too far behind and must
 * refetch everything. Events only invalidate; nothing is applied incrementally.
 */
export function connectActivity(onEvent: (event: LiveEvent) => void, onResync: () => void): () => void {
  const source = new EventSource(`/api/v1/events?token=${encodeURIComponent(getToken() ?? "")}`);
  const listener = (raw: MessageEvent<string>) => {
    onEvent({ ...(JSON.parse(raw.data) as LiveEvent), id: Number(raw.lastEventId) });
  };
  for (const type of EVENT_TYPES) source.addEventListener(type, listener as EventListener);
  source.addEventListener("resync", () => onResync());
  return () => source.close();
}
