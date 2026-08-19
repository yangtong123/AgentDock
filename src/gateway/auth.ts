import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GatewayToken {
  token: string;
  /** Where the token came from (env var name or file path), for the startup log line. */
  source: string;
}

/**
 * Resolves the gateway bearer token: AGENTDOCK_GATEWAY_TOKEN wins; otherwise a
 * generated 32-byte hex token persisted next to the database (0600). With an
 * in-memory database the token is ephemeral per process.
 */
export function resolveGatewayToken(dbPath: string): GatewayToken {
  const env = process.env.AGENTDOCK_GATEWAY_TOKEN;
  if (env !== undefined && env !== "") return { token: env, source: "env AGENTDOCK_GATEWAY_TOKEN" };
  if (dbPath === ":memory:") return { token: randomBytes(32).toString("hex"), source: "generated (ephemeral, in-memory DB)" };
  const path = join(dirname(resolve(dbPath)), "gateway-token");
  if (existsSync(path)) return { token: readFileSync(path, "utf8").trim(), source: path };
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return { token, source: path };
}

/** Constant-time comparison; length mismatch (or empty) fails closed. */
export function checkToken(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length || wanted.length === 0) return false;
  return timingSafeEqual(actual, wanted);
}
