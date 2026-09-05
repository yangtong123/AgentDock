import type { StepRun } from "../types";

/**
 * The gate a decision would act on right now: a QUEUED HUMAN_APPROVAL whose
 * every earlier step SUCCEEDED (mirror of the engine's pending-gate
 * predicate). The Approve/Reject buttons send this as expectedApprovalStepId
 * so a stale view (still showing gate 1 while the run parks at gate 2)
 * conflicts instead of deciding the wrong gate.
 */
export function pendingApprovalGateId(steps: StepRun[]): string | null {
  const gate = steps.find(
    (step) =>
      step.stepType === "HUMAN_APPROVAL" &&
      step.state === "QUEUED" &&
      steps.filter((other) => other.sequence < step.sequence).every((other) => other.state === "SUCCEEDED"),
  );
  return gate?.id ?? null;
}
