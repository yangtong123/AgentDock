import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../api";
import type { PresetsResponse, Project, TaskDetails } from "../types";
import { comboAssignment, type ProviderAssignment } from "../lib/providers";
import { ProviderAssignmentEditor } from "./ProviderAssignmentEditor";

/**
 * Task composer: create + (optionally) start in one submit. Two-phase safety:
 * once creation succeeds the created task id is kept — a resubmit only retries
 * the run POST, reusing its idempotency key, so an ambiguous failure can never
 * orphan or duplicate the task. Escape or the cancel button closes; the
 * backdrop never discards typed text.
 */
export function Composer({
  projects,
  initialProjectId,
  onCreated,
  onClose,
}: {
  projects: Project[];
  initialProjectId: string | null;
  onCreated: (taskId: string) => void;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [request, setRequest] = useState("");
  const [preset, setPreset] = useState("cross-review");
  const [assignment, setAssignment] = useState<ProviderAssignment>(() => comboAssignment("claude-build-codex-review"));
  const [maxReviewRounds, setMaxReviewRounds] = useState(3);
  const [priority, setPriority] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [createOnly, setCreateOnly] = useState(false);
  const [pending, setPending] = useState<"create" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phase state: the created task and one stable key per phase per intent.
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const createKeyRef = useRef(crypto.randomUUID());
  const runKeyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    apiGet<PresetsResponse>("/workflow-presets").then(setPresets).catch((err: Error) => setError(err.message));
    apiGet<string[]>("/providers").then(setProviders).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const project = projects.find((entry) => entry.id === projectId) ?? null;

  const submit = async (): Promise<void> => {
    if (pending !== null || request.trim() === "") return;
    setError(null);
    try {
      let taskId = createdTaskId;
      if (taskId === null) {
        setPending("create");
        const created = await apiPost<TaskDetails>("/tasks", { projectId, request: request.trim() }, createKeyRef.current);
        taskId = created.task.id;
        setCreatedTaskId(taskId);
      }
      if (!createOnly) {
        // The server prepares a DRAFT task before starting: this takes seconds.
        setPending("run");
        await apiPost(`/tasks/${taskId}/runs`, {
          preset,
          providers: assignment,
          maxReviewRounds,
          ...(priority !== "" ? { priority: Number(priority) } : {}),
          ...(scheduledAt !== "" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        }, runKeyRef.current);
      }
      onCreated(taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Creation already succeeded: say so, and offer a path to the task.
      setError(createdTaskId !== null ? `task created — starting the run failed: ${message}` : message);
      setPending(null);
    }
  };

  return (
    <div className="composer-backdrop">
      <div className="composer" role="dialog" aria-modal="true" aria-label="New task">
        <h2>New task</h2>
        <label className="field">
          <span>Project</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={createdTaskId !== null}>
            {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        {project !== null && (
          <p className="profile-note">
            permission profile: <strong>{project.permissionProfile ?? "default"}</strong>
            <span className="dim small"> — project policy; a run cannot weaken it</span>
          </p>
        )}
        <label className="field">
          <span>Requirement</span>
          <textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={4} autoFocus disabled={createdTaskId !== null} />
        </label>
        <label className="field">
          <span>Workflow preset</span>
          <select value={preset} onChange={(event) => setPreset(event.target.value)}>
            {(presets?.presets ?? []).map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name} ({entry.steps.length} steps)</option>
            ))}
          </select>
        </label>
        {providers.length > 0 && <ProviderAssignmentEditor providers={providers} value={assignment} onChange={setAssignment} />}
        <div className="field-row">
          <label className="field">
            <span>Max review rounds</span>
            <input type="number" min={1} max={10} value={maxReviewRounds} onChange={(event) => setMaxReviewRounds(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Priority (1-9, optional)</span>
            <input type="number" min={1} max={9} value={priority} onChange={(event) => setPriority(event.target.value)} placeholder="5" />
          </label>
          <label className="field">
            <span>Schedule at (optional)</span>
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
        </div>
        <label className="field inline">
          <input type="checkbox" checked={createOnly} onChange={(event) => setCreateOnly(event.target.checked)} disabled={createdTaskId !== null} />
          <span>create only (do not start a run)</span>
        </label>
        {error !== null && <p className="error">{error}</p>}
        <div className="composer-actions">
          {createdTaskId !== null && (
            <button className="link" onClick={() => onCreated(createdTaskId)}>open created task</button>
          )}
          <button className="link" onClick={onClose}>cancel</button>
          <button className="primary" disabled={pending !== null || request.trim() === "" || projectId === ""} onClick={() => void submit()}>
            {pending === "create" ? "creating…" : pending === "run" ? "preparing + starting…" : createdTaskId !== null ? "Retry start" : createOnly ? "Create task" : "Create & start"}
          </button>
        </div>
      </div>
    </div>
  );
}
