import { describe, expect, it } from "vitest";
import { assignmentFromSteps, comboAssignment, swapAssignment } from "./providers";

describe("comboAssignment", () => {
  it("maps Claude Build / Codex Review to the documented defaults", () => {
    expect(comboAssignment("claude-build-codex-review")).toEqual({
      PLAN: "claude", IMPLEMENT: "claude", FIX: "claude", REVIEW: "codex", FINAL_REVIEW: "codex",
    });
  });

  it("maps Codex Build / Claude Review to the exact swap", () => {
    expect(comboAssignment("codex-build-claude-review")).toEqual({
      PLAN: "codex", IMPLEMENT: "codex", FIX: "codex", REVIEW: "claude", FINAL_REVIEW: "claude",
    });
  });

  it("maps All Claude / All Codex", () => {
    expect(comboAssignment("all-claude")).toEqual({ PLAN: "claude", IMPLEMENT: "claude", FIX: "claude", REVIEW: "claude", FINAL_REVIEW: "claude" });
    expect(comboAssignment("all-codex")).toEqual({ PLAN: "codex", IMPLEMENT: "codex", FIX: "codex", REVIEW: "codex", FINAL_REVIEW: "codex" });
  });
});

describe("assignmentFromSteps", () => {
  it("takes the first provider per assignable step and skips HUMAN_APPROVAL", () => {
    const steps = [
      { stepType: "IMPLEMENT", provider: "codex" },
      { stepType: "VERIFY", provider: "claude" },
      { stepType: "REVIEW", provider: "claude" },
      { stepType: "HUMAN_APPROVAL", provider: "human" },
      { stepType: "REVIEW", provider: "codex" }, // second round: first wins
    ];
    expect(assignmentFromSteps(steps)).toEqual({ IMPLEMENT: "codex", REVIEW: "claude" });
  });
});

describe("swapAssignment", () => {
  it("swaps claude and codex, passes others through", () => {
    expect(swapAssignment({ IMPLEMENT: "codex", REVIEW: "claude", FIX: "custom-bot" })).toEqual({ IMPLEMENT: "claude", REVIEW: "codex", FIX: "custom-bot" });
  });
  it("swap is an involution on the two known providers", () => {
    const combo = comboAssignment("codex-build-claude-review");
    expect(swapAssignment(swapAssignment(combo))).toEqual(combo);
  });
});
