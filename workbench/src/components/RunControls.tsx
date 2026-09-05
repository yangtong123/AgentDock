import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api";
import type { PresetsResponse, RunStatus, TaskDetails, TaskRevision } from "../types";
import { assignmentFromSteps, swapAssignment, type ProviderAssignment } from "../lib/providers";
import { pendingApprovalGateId } from "../lib/steps";
import { useMutation } from "../lib/use-mutation";

/**
 * Desktop controls over the shared command layer. Every button is one user
 * intent = one idempotency key (see useMutation); mutations send the run state
 * currently displayed (expectedRunState) so a stale view 409s instead of acting.
 * Approval decisions additionally bind to the displayed gate
 * (expectedApprovalStepId): runs park at RUNNING at every gate, so the state
 * alone cannot tell a stale gate-1 request from a fresh gate-2 one.
 */
export function RunControls({ details, run, onChanged, onRunCreated }: { details: TaskDetails; run: RunStatus | null; onChanged: () => void; onRunCreated?: (runId: string) => void }) {
  const task = details.task;
  const [presets, setPresets] = useState<string[]>([]);
  const [startOpen, setStartOpen] = useState(false);
  const [startPreset, setStartPreset] = useState(run?.run.preset ?? "cross-review");
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseText, setReviseText] = useState("");
  const [reviseAndRun, setReviseAndRun] = useState(true);

  // The viewed run's preset is the start default — sync when it changes.
  useEffect(() => {
    if (run?.run.preset != null) setStartPreset(run.run.preset);
  }, [run?.run.preset]);

  useEffect(() => {
    apiGet<PresetsResponse>("/workflow-presets").then((data) => setPresets(data.presets.map((preset) => preset.name))).catch(() => undefined);
  }, []);

  const viewedRunId = run?.run.id ?? null;
  const viewedRunState = run?.run.state ?? null;
  const pendingGateId = run !== null && run.awaitingApproval ? pendingApprovalGateId(run.steps) : null;
  const requireRun = (): { runId: string; expectedRunState: string } => {
    if (viewedRunId === null || viewedRunState === null) throw new Error("no run loaded");
    return { runId: viewedRunId, expectedRunState: viewedRunState };
  };
  /** Follows a newly created run so the view shows Cancel (not a stale Retry). */
  const followRun = (status: unknown): void => {
    const createdRunId = (status as { run?: { id?: unknown } } | null)?.run?.id;
    if (typeof createdRunId === "string") onRunCreated?.(createdRunId);
  };

  const prepare = useMutation((_args: void, key) => apiPost(`/tasks/${task.id}/prepare`, {}, key), onChanged);
  const start = useMutation((args: { preset: string; providers: ProviderAssignment }, key) => apiPost(`/tasks/${task.id}/runs`, args, key), onChanged);
  const approve = useMutation((args: { approved: boolean }, key) => {
    const { runId, expectedRunState } = requireRun();
    return apiPost(`/runs/${runId}/${args.approved ? "approve" : "reject"}`, { expectedRunState, ...(pendingGateId !== null ? { expectedApprovalStepId: pendingGateId } : {}) }, key);
  }, onChanged);
  const cancel = useMutation((_args: void, key) => {
    const { runId, expectedRunState } = requireRun();
    return apiPost(`/runs/${runId}/cancel`, { expectedRunState }, key);
  }, onChanged);
  const retry = useMutation((args: { providers?: ProviderAssignment }, key) => {
    const { runId, expectedRunState } = requireRun();
    return apiPost(`/runs/${runId}/retry`, { ...(args.providers !== undefined ? { providers: args.providers } : {}), expectedRunState }, key);
  }, onChanged);
  const revise = useMutation((args: { request: string }, key) => apiPost<TaskRevision>(`/tasks/${task.id}/revisions`, args, key), onChanged);

  const latestRun = details.runs.at(-1) ?? null;
  const activeRunRevision = run !== null ? details.revisions.find((revision) => revision.id === run.run.taskRevisionId)?.revision ?? null : null;
  const currentAssignment = run !== null ? assignmentFromSteps(run.steps) : {};
  const hasForeignProviders = Object.values(currentAssignment).some((provider) => provider !== "claude" && provider !== "codex");
  const canRetry = run !== null && (run.run.state === "FAILED" || run.run.state === "CANCELLED");
  // A follow-up revision can start a run whenever no run is active; revising a
  // terminal task reopens it to READY in the domain.
  const canRerunAfterRevise = task.state !== "RUNNING" && task.state !== "CANCEL_REQUESTED" && task.state !== "DRAFT";
  const mutations = [prepare, start, approve, cancel, retry, revise];
  const anyError = mutations.find((mutation) => mutation.error !== null)?.error ?? null;
  const anyConflict = mutations.some((mutation) => mutation.conflict);
  const anyPending = mutations.some((mutation) => mutation.pending);

  const submitRevise = async (): Promise<void> => {
    if (reviseText.trim() === "") return;
    const revision = await revise.run({ request: reviseText.trim() });
    if (revision === null) return;
    setReviseOpen(false);
    setReviseText("");
    if (!reviseAndRun || !canRerunAfterRevise) return;
    // Revising reopened the task (or it was READY already): start a fresh run
    // on the new current revision with the previous run's shape.
    const status = await start.run({ preset: latestRun?.run.preset ?? "cross-review", providers: latestRun !== null ? assignmentFromSteps(latestRun.steps) : {} });
    followRun(status);
  };

  return (
    <div className="controls">
      <div className="control-buttons">
        {task.state === "DRAFT" && (
          <button className="primary" disabled={anyPending} onClick={() => void prepare.run(undefined)}>Prepare worktree</button>
        )}
        {task.state === "READY" && !startOpen && (
          <button className="primary" disabled={anyPending} onClick={() => setStartOpen(true)}>Start run…</button>
        )}
        {run?.awaitingApproval === true && (
          <>
            <button className="primary" disabled={anyPending} onClick={() => void approve.run({ approved: true })}>Approve</button>
            <button className="danger" disabled={anyPending} onClick={() => void approve.run({ approved: false })}>Reject</button>
          </>
        )}
        {run !== null && (run.run.state === "QUEUED" || run.run.state === "RUNNING") && (
          <button className="danger" disabled={anyPending} onClick={() => void cancel.run(undefined)}>Cancel</button>
        )}
        {canRetry && (
          <>
            <button className="primary" disabled={anyPending} onClick={() => void retry.run({}).then(followRun)}>Retry</button>
            <button
              disabled={anyPending}
              title={hasForeignProviders ? "swap affects claude/codex assignments only; other providers stay as-is" : "rerun with implementer/reviewer swapped"}
              onClick={() => void retry.run({ providers: swapAssignment(currentAssignment) }).then(followRun)}
            >
              Swap &amp; rerun{hasForeignProviders ? " (claude/codex only)" : ""}
            </button>
          </>
        )}
        <button disabled={anyPending} onClick={() => setReviseOpen((open) => !open)}>Revise…</button>
      </div>
      {anyConflict && <p className="badge attention">conflict — the view was stale; refreshed</p>}
      {anyError !== null && <p className="error">{anyError}</p>}
      {startOpen && task.state === "READY" && (
        <div className="start-panel">
          <select value={startPreset} onChange={(event) => setStartPreset(event.target.value)}>
            {(presets.length > 0 ? presets : ["fast", "cross-review", "careful", "fix"]).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            className="primary"
            disabled={anyPending}
            onClick={() => {
              setStartOpen(false);
              void start.run({ preset: startPreset, providers: latestRun !== null ? assignmentFromSteps(latestRun.steps) : {} }).then(followRun);
            }}
          >
            Start
          </button>
          <span className="small dim">providers reused from the previous run</span>
        </div>
      )}
      {reviseOpen && (
        <div className="revise-panel">
          <textarea value={reviseText} onChange={(event) => setReviseText(event.target.value)} rows={3} placeholder="Follow-up requirement…" />
          {activeRunRevision !== null && activeRunRevision !== details.task.currentRevision && (
            <p className="small dim">shown run is on r{activeRunRevision}; you are revising towards r{details.task.currentRevision + 1}</p>
          )}
          {task.state === "RUNNING" && <p className="small dim">a run is active on r{activeRunRevision ?? "?"}; the revision is immutable history until it finishes</p>}
          <label className="field inline">
            <input type="checkbox" checked={reviseAndRun && canRerunAfterRevise} disabled={!canRerunAfterRevise} onChange={(event) => setReviseAndRun(event.target.checked)} />
            <span>start a new run on the new revision{!canRerunAfterRevise ? ` (unavailable while ${task.state})` : ""}</span>
          </label>
          <div>
            <button className="primary" disabled={anyPending || reviseText.trim() === ""} onClick={() => void submitRevise()}>Submit revision</button>
          </div>
        </div>
      )}
    </div>
  );
}
