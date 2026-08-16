import type { StepType } from "../shared/domain.js";
import { ValidationError } from "../shared/domain.js";

/** Provider assignment per step type. Unset steps fall back to defaults. */
export type ProviderAssignment = Partial<Record<StepType, string>>;

export interface WorkflowStepDefinition {
  stepType: StepType;
  /** Provider id (e.g. "claude", "codex"); overridden by per-run assignment. */
  provider: string | null;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStepDefinition[];
}

export const DEFAULT_PROVIDERS: Record<StepType, string> = {
  PLAN: "claude",
  IMPLEMENT: "claude",
  VERIFY: "claude",
  REVIEW: "codex",
  FIX: "claude",
  FINAL_REVIEW: "codex",
  HUMAN_APPROVAL: "human",
};

const fast: StepType[] = ["IMPLEMENT", "VERIFY"];
const crossReview: StepType[] = ["IMPLEMENT", "VERIFY", "REVIEW", "FIX", "VERIFY", "FINAL_REVIEW"];
const careful: StepType[] = ["PLAN", "HUMAN_APPROVAL", "IMPLEMENT", "VERIFY", "REVIEW", "FIX", "VERIFY", "FINAL_REVIEW", "HUMAN_APPROVAL"];

/**
 * Presets expand to step sequences; provider assignment happens at expansion
 * time so per-run overrides and defaults stay in one place. Providers are
 * configurable per step — roles and providers stay decoupled.
 */
export function expandPreset(preset: string, providers: ProviderAssignment = {}): WorkflowStepDefinition[] {
  const sequences: Record<string, StepType[]> = { fast, "cross-review": crossReview, careful };
  const sequence = sequences[preset];
  if (!sequence) throw new ValidationError(`Unknown workflow preset: ${preset} (expected fast, cross-review, or careful)`);
  return sequence.map((stepType) => ({ stepType, provider: providers[stepType] ?? DEFAULT_PROVIDERS[stepType] }));
}
