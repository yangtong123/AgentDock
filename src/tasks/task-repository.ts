import type { Database } from "../db/database.js";
import type { Task, TaskRevision, TaskState } from "../shared/domain.js";
import { NotFoundError } from "../shared/domain.js";

export interface TaskChanges { state?: TaskState; branch?: string | null; worktreePath?: string | null }

type TaskRow = { id: string; project_id: string; state: TaskState; current_revision: number; branch: string | null; worktree_path: string | null; created_at: string; updated_at: string };
type RevisionRow = { id: string; task_id: string; revision: number; request: string; created_at: string };
const mapTask = (r: TaskRow): Task => ({ id:r.id, projectId:r.project_id, state:r.state, currentRevision:r.current_revision, branch:r.branch, worktreePath:r.worktree_path, createdAt:r.created_at, updatedAt:r.updated_at });
const mapRevision = (r: RevisionRow): TaskRevision => ({ id:r.id, taskId:r.task_id, revision:r.revision, request:r.request, createdAt:r.created_at });

export interface TaskRepository {
  createWithRevision(task: Task, revision: TaskRevision): void;
  addRevision(taskId: string, revision: TaskRevision, updatedAt: string): void;
  update(taskId: string, changes: TaskChanges, updatedAt: string): Task;
  findById(id: string): Task | undefined;
  findRevision(taskId: string, revision: number): TaskRevision | undefined;
  findRevisionById(revisionId: string): TaskRevision | undefined;
  listRevisions(taskId: string): TaskRevision[];
  list(projectId?: string): Task[];
}
export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}
  createWithRevision(task: Task, revision: TaskRevision): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO tasks (id,project_id,state,current_revision,branch,worktree_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(task.id,task.projectId,task.state,task.currentRevision,task.branch,task.worktreePath,task.createdAt,task.updatedAt);
      this.db.prepare("INSERT INTO task_revisions (id,task_id,revision,request,created_at) VALUES (?,?,?,?,?)").run(revision.id,revision.taskId,revision.revision,revision.request,revision.createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  addRevision(taskId: string, revision: TaskRevision, updatedAt: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE tasks SET current_revision = ?, updated_at = ? WHERE id = ? AND current_revision = ?").run(revision.revision, updatedAt, taskId, revision.revision - 1);
      if (result.changes !== 1) throw new Error("Task revision changed concurrently or task does not exist");
      this.db.prepare("INSERT INTO task_revisions (id,task_id,revision,request,created_at) VALUES (?,?,?,?,?)").run(revision.id,revision.taskId,revision.revision,revision.request,revision.createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  update(taskId:string,changes:TaskChanges,updatedAt:string):Task {
    const sets:string[]=[]; const values:(string|number|null)[]=[];
    if(changes.state!==undefined){sets.push("state = ?");values.push(changes.state);}
    if(changes.branch!==undefined){sets.push("branch = ?");values.push(changes.branch);}
    if(changes.worktreePath!==undefined){sets.push("worktree_path = ?");values.push(changes.worktreePath);}
    sets.push("updated_at = ?"); values.push(updatedAt);
    const result=this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values,taskId);
    if(result.changes!==1) throw new NotFoundError(`Task ${taskId} not found`);
    return this.findById(taskId)!;
  }
  findById(id:string):Task|undefined { const r=this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow|undefined; return r&&mapTask(r); }
  findRevision(taskId:string,revision:number):TaskRevision|undefined { const r=this.db.prepare("SELECT * FROM task_revisions WHERE task_id=? AND revision=?").get(taskId,revision) as RevisionRow|undefined; return r&&mapRevision(r); }
  findRevisionById(revisionId:string):TaskRevision|undefined { const r=this.db.prepare("SELECT * FROM task_revisions WHERE id=?").get(revisionId) as RevisionRow|undefined; return r&&mapRevision(r); }
  listRevisions(taskId:string):TaskRevision[] { return (this.db.prepare("SELECT * FROM task_revisions WHERE task_id=? ORDER BY revision").all(taskId) as RevisionRow[]).map(mapRevision); }
  list(projectId?:string):Task[] { const rows = projectId === undefined ? this.db.prepare("SELECT * FROM tasks ORDER BY created_at,id").all() : this.db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id").all(projectId); return (rows as TaskRow[]).map(mapTask); }
}
