/** Provider assignment helpers: quick combos, extraction from run steps, swap. Pure, unit-tested. */

export const ASSIGNABLE_STEPS = ["PLAN", "IMPLEMENT", "REVIEW", "FIX", "FINAL_REVIEW"] as const;
export type AssignableStep = (typeof ASSIGNABLE_STEPS)[number];
export type ProviderAssignment = Partial<Record<AssignableStep, string>>;

export type QuickCombo = "claude-build-codex-review" | "codex-build-claude-review" | "all-claude" | "all-codex";

export const QUICK_COMBOS: { id: QuickCombo; label: string }[] = [
  { id: "claude-build-codex-review", label: "Claude Build / Codex Review" },
  { id: "codex-build-claude-review", label: "Codex Build / Claude Review" },
  { id: "all-claude", label: "All Claude" },
  { id: "all-codex", label: "All Codex" },
];

/** Quick combos are UI presets over per-step assignments; PLAN follows the implementer. */
export function comboAssignment(combo: QuickCombo): ProviderAssignment {
  switch (combo) {
    case "claude-build-codex-review":
      return { PLAN: "claude", IMPLEMENT: "claude", FIX: "claude", REVIEW: "codex", FINAL_REVIEW: "codex" };
    case "codex-build-claude-review":
      return { PLAN: "codex", IMPLEMENT: "codex", FIX: "codex", REVIEW: "claude", FINAL_REVIEW: "claude" };
    case "all-claude":
      return { PLAN: "claude", IMPLEMENT: "claude", FIX: "claude", REVIEW: "claude", FINAL_REVIEW: "claude" };
    case "all-codex":
      return { PLAN: "codex", IMPLEMENT: "codex", FIX: "codex", REVIEW: "codex", FINAL_REVIEW: "codex" };
  }
}

/** Extracts the effective assignment from a run's steps (first occurrence per step type). */
export function assignmentFromSteps(steps: { stepType: string; provider: string | null }[]): ProviderAssignment {
  const result: ProviderAssignment = {};
  for (const step of steps) {
    if ((ASSIGNABLE_STEPS as readonly string[]).includes(step.stepType) && step.provider !== null && result[step.stepType as AssignableStep] === undefined) {
      result[step.stepType as AssignableStep] = step.provider;
    }
  }
  return result;
}

/** Swaps claude ↔ codex; unknown providers pass through unchanged. */
export function swapAssignment(assignment: ProviderAssignment): ProviderAssignment {
  const result: ProviderAssignment = {};
  for (const [step, provider] of Object.entries(assignment)) {
    result[step as AssignableStep] = provider === "claude" ? "codex" : provider === "codex" ? "claude" : provider;
  }
  return result;
}
