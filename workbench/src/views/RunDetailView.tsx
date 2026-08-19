import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api";
import type { ActivityEvent, Artifact, ReviewFinding, RunStatus, StepRun, TaskDetails } from "../types";
import { LogPane } from "../components/LogPane";
import { DiffView } from "../components/DiffView";
import { RunControls } from "../components/RunControls";

function payloadOf(event: ActivityEvent): Record<string, unknown> {
  if (typeof event.payload === "string") {
    try { return JSON.parse(event.payload) as Record<string, unknown>; } catch { return {}; }
  }
  return (event.payload ?? {}) as Record<string, unknown>;
}

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function StepTimeline({ steps, selected, onSelect }: { steps: StepRun[]; selected: string | null; onSelect: (stepId: string) => void }) {
  return (
    <ol className="steps">
      {steps.map((step) => (
        <li
          key={step.id}
          className={`step state-${step.state.toLowerCase()} ${selected === step.id ? "selected" : ""}`}
          onClick={() => onSelect(step.id)}
        >
          <span className="step-type">{step.stepType}</span>
          <span className="small dim">{step.provider ?? "—"}</span>
          <span className={`badge state-${step.state.toLowerCase().replace("_", "-")}`}>{step.state}</span>
          <span className="small dim">{duration(step.durationMs)}</span>
          {step.reviewRound !== null && step.reviewRound !== undefined && <span className="small dim">round {step.reviewRound}</span>}
        </li>
      ))}
    </ol>
  );
}

function VerifySection({ steps, activity }: { steps: StepRun[]; activity: ActivityEvent[] }) {
  const verifySteps = steps.filter((step) => step.stepType === "VERIFY");
  if (verifySteps.length === 0) return null;
  return (
    <section>
      <h3>Verification (deterministic)</h3>
      {verifySteps.map((step) => {
        const event = activity.filter((entry) => entry.type === "verify.completed" && entry.stepRunId === step.id).at(-1);
        const payload = event !== undefined ? payloadOf(event) : null;
        return (
          <div key={step.id} className="verify">
            <span className={`badge ${step.state === "SUCCEEDED" ? "state-succeeded" : step.state === "FAILED" ? "state-failed" : ""}`}>
              {payload !== null ? (payload.ok === true ? "verify ok" : "verify failed") : step.state}
            </span>
            <span className="small dim">{duration(step.durationMs)}</span>
            {typeof payload?.output === "string" && payload.output !== "" && <pre className="mono verify-output">{payload.output}</pre>}
          </div>
        );
      })}
    </section>
  );
}

function FindingsSection({ artifacts, steps }: { artifacts: Artifact[]; steps: StepRun[] }) {
  const findingsArtifacts = artifacts.filter((artifact) => artifact.kind === "review-findings" && artifact.storage.type === "INLINE");
  if (findingsArtifacts.length === 0) return null;
  const stepLabel = new Map(steps.map((step) => [step.id, `${step.stepType}${step.reviewRound != null ? ` round ${step.reviewRound}` : ""}`]));
  return (
    <section>
      <h3>Review findings</h3>
      {findingsArtifacts.map((artifact) => {
        let findings: ReviewFinding[] = [];
        try { findings = JSON.parse((artifact.storage as { type: "INLINE"; content: string }).content) as ReviewFinding[]; } catch { findings = []; }
        return (
          <div key={artifact.id} className="findings-group">
            <h4 className="small dim">{artifact.stepRunId !== null ? stepLabel.get(artifact.stepRunId) ?? "review" : "review"}</h4>
            <ul className="findings">
              {findings.map((finding, index) => (
                <li key={index}>
                  <span className={`badge severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span>
                  {finding.file !== null && <span className="mono small">{finding.file}{finding.line !== null ? `:${finding.line}` : ""}</span>}
                  <span>{finding.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function ArtifactsSection({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <section>
      <h3>Artifacts</h3>
      <table className="artifacts">
        <thead><tr><th>kind</th><th>name</th><th>storage</th><th>created</th></tr></thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr key={artifact.id}>
              <td className="mono small">{artifact.kind}</td>
              <td className="mono small">{artifact.name}</td>
              <td className="small dim">
                {artifact.storage.type === "INLINE" ? `inline (${artifact.storage.content.length} chars)` : "file"}
              </td>
              <td className="small dim">{new Date(artifact.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ActivityTimeline({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) return null;
  return (
    <section>
      <h3>Activity</h3>
      <ol className="activity">
        {[...activity].reverse().map((event) => (
          <li key={event.id}>
            <span className="mono small dim">{new Date(event.createdAt).toLocaleTimeString()}</span>
            <span className="mono small">{event.type}</span>
            <span className="badge actor">{event.actor ?? "system"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RunDetailView({ taskId, tick, onBack }: { taskId: string; tick: number; onBack: () => void }) {
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mutations bump the local tick: effects refetch on tick + localTick.
  const [localTick, setLocalTick] = useState(0);
  const refresh = (): void => setLocalTick((value) => value + 1);

  useEffect(() => {
    apiGet<TaskDetails>(`/tasks/${taskId}`)
      .then((data) => {
        setDetails(data);
        setRunId((current) => current ?? data.runs.at(-1)?.run.id ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, [taskId, tick, localTick]);

  useEffect(() => {
    apiGet<Artifact[]>(`/tasks/${taskId}/artifacts`).then(setArtifacts).catch(() => undefined);
    apiGet<ActivityEvent[]>(`/tasks/${taskId}/activity?limit=200`).then(setActivity).catch(() => undefined);
  }, [taskId, tick, localTick]);

  useEffect(() => {
    if (runId === null) { setRun(null); return; }
    apiGet<RunStatus>(`/runs/${runId}`)
      .then((data) => {
        setRun(data);
        setSelectedStep((current) => {
          if (current !== null && data.steps.some((step) => step.id === current)) return current;
          return data.steps.find((step) => step.state === "RUNNING")?.id ?? data.steps.at(-1)?.id ?? null;
        });
      })
      .catch((err: Error) => setError(err.message));
  }, [runId, tick, localTick]);

  const selected = useMemo(() => run?.steps.find((step) => step.id === selectedStep) ?? null, [run, selectedStep]);

  if (error !== null) return <p className="error">{error}</p>;
  if (details === null) return <p className="dim">loading…</p>;

  return (
    <div className="run-view">
      <div className="run-header">
        <button className="link" onClick={onBack}>← tasks</button>
        <h2 className="mono">{details.task.id.slice(0, 8)}</h2>
        <span className={`badge state-${details.task.state.toLowerCase().replace("_", "-")}`}>{details.task.state}</span>
        <span className="small dim">rev {details.task.currentRevision}</span>
        <span className="mono small dim">{details.task.branch ?? "no branch"}</span>
        {run !== null && (
          <select value={runId ?? ""} onChange={(event) => { setRunId(event.target.value); setSelectedStep(null); }}>
            {details.runs.map((entry, index) => (
              <option key={entry.run.id} value={entry.run.id}>
                run {index + 1} · {entry.run.preset ?? "default"} · {entry.run.state}
              </option>
            ))}
          </select>
        )}
        {run?.awaitingApproval === true && <span className="badge attention">awaiting approval</span>}
      </div>
      <RunControls details={details} run={run} onChanged={refresh} />
      <p className="request">{details.currentRevision.request}</p>
      {run === null
        ? <p className="dim">No runs yet.</p>
        : (
          <>
            <StepTimeline steps={run.steps} selected={selectedStep} onSelect={setSelectedStep} />
            {selected !== null && (
              <section>
                <h3 className="mono small">{selected.stepType} · {selected.provider ?? "—"} · {selected.state}</h3>
                {selected.stepType !== "HUMAN_APPROVAL" && selected.stepType !== "VERIFY" && (
                  <LogPane stepRunId={selected.id} running={selected.state === "RUNNING"} />
                )}
              </section>
            )}
            <VerifySection steps={run.steps} activity={activity} />
            <FindingsSection artifacts={artifacts} steps={run.steps} />
          </>
        )}
      <section>
        <h3>Diff</h3>
        <DiffView taskId={taskId} tick={tick + localTick} />
      </section>
      <ArtifactsSection artifacts={artifacts} />
      <section>
        <h3>Revisions</h3>
        <ol className="revisions">
          {details.revisions.map((revision) => (
            <li key={revision.id} className={revision.revision === details.task.currentRevision ? "current" : ""}>
              <span className="badge">r{revision.revision}</span> {revision.request}
              <span className="small dim"> · {new Date(revision.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ol>
      </section>
      <ActivityTimeline activity={activity} />
    </div>
  );
}
