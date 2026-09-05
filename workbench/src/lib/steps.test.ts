import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { StepRun } from "../types";
import { pendingApprovalGateId } from "./steps";

function step(id: string, stepType: string, sequence: number, state: string): StepRun {
  return { id, workflowRunId: "w", stepType, state, sequence, provider: null, createdAt: "", updatedAt: "", durationMs: null, reviewRound: null } as unknown as StepRun;
}

describe("pendingApprovalGateId", () => {
  it("finds the QUEUED gate whose earlier steps all succeeded", () => {
    const steps = [
      step("s1", "PLAN", 0, "SUCCEEDED"),
      step("g1", "HUMAN_APPROVAL", 1, "SUCCEEDED"),
      step("s2", "IMPLEMENT", 2, "SUCCEEDED"),
      step("g2", "HUMAN_APPROVAL", 3, "QUEUED"),
    ];
    assert.equal(pendingApprovalGateId(steps), "g2");
  });

  it("ignores a future gate while an earlier step is unfinished", () => {
    const steps = [
      step("s1", "PLAN", 0, "SUCCEEDED"),
      step("g1", "HUMAN_APPROVAL", 1, "QUEUED"),
      step("s2", "IMPLEMENT", 2, "QUEUED"),
      step("g2", "HUMAN_APPROVAL", 3, "QUEUED"),
    ];
    assert.equal(pendingApprovalGateId(steps), "g1");
  });

  it("returns null with no pending gate", () => {
    assert.equal(pendingApprovalGateId([step("s1", "IMPLEMENT", 0, "RUNNING")]), null);
    assert.equal(pendingApprovalGateId([]), null);
  });
});
