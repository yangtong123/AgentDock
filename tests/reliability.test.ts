import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, type Database } from "../src/db/database.js";
import { CommandDedup, TransactionalOutbox, LeaseManager, type Clock } from "../src/reliability/outbox.js";
import { TaskQueue } from "../src/reliability/task-queue.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms: number) => { current += ms; } };
}

function freshDb(): Database { return openDatabase(":memory:"); }

test("CommandDedup claims each key exactly once and prunes by age", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const dedup = new CommandDedup(db, () => clock.now().toISOString());
  assert.equal(dedup.claim("cmd-1"), true);
  assert.equal(dedup.claim("cmd-1"), false, "duplicate tap is a no-op");
  assert.equal(dedup.claim("cmd-2"), true);
  clock.advance(10 * 60 * 1000);
  assert.equal(dedup.pruneOlderThan(clock.now().toISOString()), 2);
  assert.equal(dedup.claim("cmd-1"), true, "pruned keys can be claimed again");
  db.close();
});

test("TransactionalOutbox publishes, claims batches, and marks processed", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const outbox = new TransactionalOutbox(db, () => clock.now().toISOString());
  outbox.publish({ taskId: "t1", type: "run.succeeded", payload: { runId: "r1" } });
  outbox.publish({ taskId: "t2", type: "run.failed", payload: { runId: "r2" } });
  const batch = outbox.claimBatch("w1", 10);
  assert.equal(batch.length, 2);
  assert.deepEqual(JSON.parse(batch[0]!.payload), { runId: "r1" });
  outbox.markProcessed(batch[0]!.id, "w1");
  const remaining = outbox.claimBatch("w2", 10);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, batch[1]!.id);
  db.close();
});

test("LeaseManager: exclusive acquire, heartbeat renewal, expiry, release", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const leases = new LeaseManager(db, clock);
  assert.equal(leases.acquire("task:t1", "w1", "t1", 60_000), true);
  assert.equal(leases.acquire("task:t1", "w2", "t1", 60_000), false, "second worker cannot steal a live lease");
  clock.advance(30_000);
  assert.equal(leases.heartbeat("task:t1", "w1", 60_000), true);
  clock.advance(45_000);
  assert.equal(leases.acquire("task:t1", "w2", "t1", 60_000), false, "heartbeat kept the lease alive past the original TTL");
  assert.equal(leases.heartbeat("task:t1", "w2", 60_000), false, "heartbeat only works for the owner");
  clock.advance(60_001);
  assert.equal(leases.acquire("task:t1", "w2", "t1", 60_000), true, "expired lease becomes claimable");
  leases.release("task:t1", "w2");
  assert.equal(leases.expired("t1").length, 0);
  db.close();
});

test("TaskQueue: priority order, scheduling, and validation", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const queue = new TaskQueue(db, clock);
  queue.enqueue("low", { priority: 1 });
  queue.enqueue("high", { priority: 9 });
  queue.enqueue("scheduled", { priority: 5, scheduledAt: new Date(Date.UTC(2026, 0, 2)) });
  const next = queue.nextDue(() => 0, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 5 });
  assert.equal(next!.taskId, "high", "priority 9 dequeues first");
  queue.dequeue("high");
  const second = queue.nextDue(() => 0, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 5 });
  assert.equal(second!.taskId, "low");
  clock.advance(24 * 60 * 60 * 1000);
  const third = queue.nextDue(() => 0, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 5 });
  assert.equal(third!.taskId, "scheduled", "future-scheduled task waits until due");
  assert.throws(() => queue.enqueue("bad", { priority: 0 as unknown as number }), /1-9/);
  db.close();
});

test("TaskQueue: paused projects and concurrency gates block dequeue", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const queue = new TaskQueue(db, clock);
  queue.enqueue("t1");
  queue.enqueue("t2");
  const paused = queue.nextDue(() => 0, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "PAUSED", maxConcurrentByProject: () => 5 });
  assert.equal(paused, undefined, "PAUSED projects dequeue nothing");
  const atProjectCap = queue.nextDue(() => 1, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 1 });
  assert.equal(atProjectCap, undefined, "project concurrency cap blocks");
  const atGlobalCap = queue.nextDue(() => 0, 3, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 5 });
  assert.equal(atGlobalCap, undefined, "global concurrency cap blocks");
  const allowed = queue.nextDue(() => 0, 0, { globalConcurrency: 3, projectIdOf: () => "p1", projectStatus: () => "ACTIVE", maxConcurrentByProject: () => 5 });
  assert.equal(allowed!.taskId, "t1");
  db.close();
});

test("TaskQueue: orphaned entries are detected and purged", () => {
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const db = freshDb();
  const queue = new TaskQueue(db, clock);
  queue.enqueue("live");
  queue.enqueue("done");
  const orphans = queue.orphans((taskId) => taskId === "live");
  assert.deepEqual(orphans, ["done"]);
  assert.equal(queue.purge(orphans), 1);
  assert.equal(queue.size(), 1);
  db.close();
});
