import { ValidationError } from "../shared/domain.js";

/** Structured review finding parsed from a reviewer agent's output. */
export interface ReviewFinding {
  id: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR" | "NIT";
  file: string | null;
  line: number | null;
  summary: string;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  verdict: "PASS" | "NEEDS_FIXES";
  raw: string;
}

/**
 * Parses structured findings from reviewer stdout. Agents are prompted to
 * emit blocks like:
 *   FINDING [BLOCKER] src/foo.ts:42 summary text
 * and a final verdict line `VERDICT: PASS` or `VERDICT: NEEDS_FIXES`.
 * Anything unparseable degrades to the raw text with a NEEDS_FIXES verdict
 * only when the reviewer flagged failure; deterministic verification remains
 * the higher authority.
 */
export function parseReviewReport(raw: string): ReviewReport {
  const findings: ReviewFinding[] = [];
  let index = 0;
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*FINDING\s+\[(BLOCKER|MAJOR|MINOR|NIT)\]\s*(?:([^\s:]+):(\d+)\s*)?(.+)$/);
    if (match) {
      findings.push({
        id: `F${++index}`,
        severity: match[1] as ReviewFinding["severity"],
        file: match[2] ?? null,
        line: match[3] !== undefined ? Number(match[3]) : null,
        summary: match[4]!.trim(),
      });
    }
  }
  const verdictMatch = raw.match(/VERDICT:\s*(PASS|NEEDS_FIXES)/);
  const verdict = verdictMatch ? (verdictMatch[1] as ReviewReport["verdict"]) : (findings.length > 0 ? "NEEDS_FIXES" : "PASS");
  return { findings, verdict, raw };
}

/** Renders findings back into the prompt format FIX agents consume. */
export function renderFindings(findings: ReviewFinding[]): string {
  return findings.map((f) => `- [${f.severity}]${f.file ? ` ${f.file}${f.line !== null ? `:${f.line}` : ""}` : ""} ${f.summary}`).join("\n");
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

export function validateMaxReviewRounds(rounds: number): number {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new ValidationError("maxReviewRounds must be an integer between 1 and 10");
  return rounds;
}

/** Session policy per step role: resume the role's thread or always start fresh. */
export type SessionPolicy = "RESUME" | "FRESH";

export const DEFAULT_SESSION_POLICIES: Record<string, SessionPolicy> = {
  PLAN: "RESUME",
  IMPLEMENT: "RESUME",
  VERIFY: "FRESH",
  REVIEW: "FRESH",
  FIX: "RESUME",
  FINAL_REVIEW: "FRESH",
};
