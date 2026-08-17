import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface ProcessOptions {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  /** Owner grouping so cancellation can target one task's processes, not all. */
  owner?: string;
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

export class ProcessTimeoutError extends Error {
  constructor(readonly result: ProcessResult) { super("process timed out"); this.name = "ProcessTimeoutError"; }
}

export class ProcessCancelledError extends Error {
  constructor(readonly result: ProcessResult) { super(`process was cancelled`); this.name = "ProcessCancelledError"; }
}

interface RunningProcess {
  cancel(reason: "timeout" | "cancel"): void;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class ProcessRunner {
  private readonly running = new Map<string, { owner: string | undefined; entry: { cancel(reason: "timeout" | "cancel"): void } }>();

  /**
   * Spawns a process with shell semantics disabled. argv is always an argument
   * array — user/IM input must never be concatenated into a shell string.
   */
  async run(options: ProcessOptions): Promise<ProcessResult> {
    const [command] = options.argv;
    if (!command) throw new Error("argv must contain at least the command");
    const handle = randomUUID();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let truncated = false;

    // detached on POSIX makes the child a process-group leader so the whole
    // tree (agent-spawned git/shell children) can be signalled at once.
    const child = spawn(command, options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const append = (current: string, chunk: string): string => {
      if (Buffer.byteLength(current) + chunk.length > MAX_OUTPUT_BYTES) { truncated = true; return current; }
      return current + chunk;
    };

    const finish = (exitCode: number | null, signal: string | null): ProcessResult =>
      ({ stdout: truncated ? `${stdout}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : stdout, stderr, exitCode, signal, timedOut, cancelled });

    let resolveResult: (result: ProcessResult) => void;
    const resultPromise = new Promise<ProcessResult>((resolve) => { resolveResult = resolve; });

    const killTree = (): void => {
      if (process.platform === "win32") { if (child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]); return; }
      if (child.pid === undefined) { child.kill("SIGTERM"); return; }
      // Signal the process group (-pid); fall back to the child alone if it never became a leader.
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    const forceKillTree = (): void => {
      if (process.platform === "win32") { if (child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]); }
      else if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };

    // A cancelled process gets 5s of SIGTERM grace, then SIGKILL — independent
    // of the (possibly much longer) step timeout. A cancelled agent must never
    // keep writing to the worktree after its owner gave it up.
    let cancelEscalation: NodeJS.Timeout | null = null;
    this.running.set(handle, { owner: options.owner, entry: {
      cancel: (reason) => {
        if (reason === "timeout") timedOut = true; else cancelled = true;
        killTree();
        if (reason === "cancel") {
          if (cancelEscalation) clearTimeout(cancelEscalation);
          cancelEscalation = setTimeout(() => { if (this.running.has(handle)) forceKillTree(); }, 5_000);
        }
      },
    } });

    child.stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString(); stdout = append(stdout, text); options.onStdout?.(text); });
    child.stderr?.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = append(stderr, text); options.onStderr?.(text); });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", (exitCode, signal) => { this.running.delete(handle); resolveResult(finish(exitCode, signal)); });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();

    const timer = options.timeoutMs > 0 ? setTimeout(() => this.running.get(handle)?.entry.cancel("timeout"), options.timeoutMs) : null;
    // SIGTERM escalation: a child that ignores SIGTERM must not outlive the run forever.
    const killTimer = options.timeoutMs > 0 ? setTimeout(() => { if (this.running.has(handle)) forceKillTree(); }, options.timeoutMs + 5_000) : null;

    const result = await resultPromise;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (cancelEscalation) clearTimeout(cancelEscalation);
    if (result.timedOut) throw new ProcessTimeoutError(result);
    if (result.cancelled) throw new ProcessCancelledError(result);
    return result;
  }

  /** Cancels only the processes belonging to one owner (task); other tasks keep running. */
  cancelOwner(owner: string): void {
    for (const record of this.running.values()) if (record.owner === owner) record.entry.cancel("cancel");
  }

  cancelAll(): void {
    for (const record of this.running.values()) record.entry.cancel("cancel");
  }
}
