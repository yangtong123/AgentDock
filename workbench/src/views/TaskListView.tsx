import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api";
import type { Project, Task } from "../types";
import { Composer } from "../components/Composer";

const STATES = ["DRAFT", "READY", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "CANCEL_REQUESTED"] as const;

function StateBadge({ state }: { state: string }) {
  return <span className={`badge state-${state.toLowerCase().replace("_", "-")}`}>{state}</span>;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: (taskId: string) => void }) {
  const latest = task.latestRun ?? null;
  return (
    <tr onClick={() => onOpen(task.id)}>
      <td><StateBadge state={task.state} /></td>
      <td className="mono small">{task.id.slice(0, 8)}</td>
      <td>r{task.currentRevision}</td>
      <td className="mono small">{task.branch ?? "—"}</td>
      <td>{latest === null ? "—" : <StateBadge state={latest.state} />}</td>
      <td className="badges">
        {latest?.awaitingApproval === true && <span className="badge attention">approval</span>}
        {(task.state === "FAILED" || latest?.state === "FAILED") && <span className="badge failed">failed</span>}
        {(task.state === "CANCELLED" || task.state === "CANCEL_REQUESTED") && <span className="badge cancelled">cancelled</span>}
        {task.hasReviewFindings === true && <span className="badge findings">findings</span>}
      </td>
      <td className="small dim">{timeAgo(task.updatedAt)}</td>
    </tr>
  );
}

export function TaskListView({ tick, onOpen }: { tick: number; onOpen: (taskId: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    apiGet<Project[]>("/projects").then(setProjects).catch((err: Error) => setError(err.message));
  }, [tick]);

  useEffect(() => {
    const query = new URLSearchParams();
    if (projectId !== null) query.set("projectId", projectId);
    if (stateFilter !== null) query.set("state", stateFilter);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    apiGet<Task[]>(`/tasks${suffix}`).then(setTasks).catch((err: Error) => setError(err.message));
  }, [tick, projectId, stateFilter]);

  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  return (
    <div className="list-view">
      <aside className="sidebar">
        <h2>Projects</h2>
        <button className={projectId === null ? "project selected" : "project"} onClick={() => setProjectId(null)}>
          <span>All projects</span>
        </button>
        {projects.map((project) => (
          <button
            key={project.id}
            className={projectId === project.id ? "project selected" : "project"}
            onClick={() => setProjectId(project.id)}
          >
            <span>
              {project.status === "ACTIVE" ? "●" : "○"} {project.name}
            </span>
            <span className="small dim">{project.status} · ×{project.maxConcurrentTasks}</span>
          </button>
        ))}
      </aside>
      <main className="content">
        <div className="filters">
          <button className={stateFilter === null ? "chip selected" : "chip"} onClick={() => setStateFilter(null)}>all</button>
          {STATES.map((state) => (
            <button key={state} className={stateFilter === state ? "chip selected" : "chip"} onClick={() => setStateFilter(state === stateFilter ? null : state)}>
              {state}
            </button>
          ))}
          <button className="chip new-task" disabled={projects.length === 0} onClick={() => setComposerOpen(true)}>+ new task</button>
        </div>
        {error !== null && <p className="error">{error}</p>}
        <table className="tasks">
          <thead>
            <tr><th>state</th><th>task</th><th>rev</th><th>branch</th><th>run</th><th>attention</th><th>updated</th></tr>
          </thead>
          <tbody>
            {tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={onOpen} />)}
            {tasks.length === 0 && <tr><td colSpan={7} className="dim">No tasks.</td></tr>}
          </tbody>
        </table>
        <p className="small dim">{tasks.length} task(s) · project: {projectId === null ? "all" : projectNames.get(projectId) ?? projectId}</p>
      </main>
      {composerOpen && (
        <Composer
          projects={projects}
          initialProjectId={projectId}
          onClose={() => setComposerOpen(false)}
          onCreated={(taskId) => {
            setComposerOpen(false);
            onOpen(taskId);
          }}
        />
      )}
    </div>
  );
}
