import { STEP_TYPES, ValidationError, type StepType } from "../shared/domain.js";

/** Tiny request validators: every rejection is a ValidationError (→ 400). */

export function asString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  return value;
}

export function asOptionalString(value: unknown, field: string, maxLength = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, maxLength);
}

export function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export function asInt(value: unknown, field: string, options: { min?: number; max?: number } = {}): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) throw new ValidationError(`${field} must be an integer`);
  if (options.min !== undefined && parsed < options.min) throw new ValidationError(`${field} must be >= ${options.min}`);
  if (options.max !== undefined && parsed > options.max) throw new ValidationError(`${field} must be <= ${options.max}`);
  return parsed;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ValidationError(`${field} must be a boolean`);
}

/** providers: { STEP_TYPE: providerName } — both sides validated against known values. */
export function asProviders(value: unknown, knownProviders: string[]): Partial<Record<StepType, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("providers must be an object mapping step type to provider name");
  const result: Partial<Record<StepType, string>> = {};
  for (const [step, provider] of Object.entries(value)) {
    if (!(STEP_TYPES as readonly string[]).includes(step)) throw new ValidationError(`providers: unknown step type ${step} (expected ${STEP_TYPES.join(", ")})`);
    if (typeof provider !== "string" || !knownProviders.includes(provider)) throw new ValidationError(`providers: unknown provider ${String(provider)} for ${step} (known: ${knownProviders.join(", ")})`);
    result[step as StepType] = provider;
  }
  return result;
}
