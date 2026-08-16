import type { Database } from "../db/database.js";
import type { Project, ProjectStatus } from "../shared/domain.js";
import { NotFoundError } from "../shared/domain.js";

type ProjectRow = { id: string; name: string; repo_path: string; base_branch: string; worktree_root: string; status: ProjectStatus; max_concurrent_tasks: number; default_workflow_preset: string | null; verify_command: string | null; created_at: string; updated_at: string };
const mapProject = (row: ProjectRow): Project => ({ id: row.id, name: row.name, repoPath: row.repo_path, baseBranch: row.base_branch, worktreeRoot: row.worktree_root, status: row.status, maxConcurrentTasks: row.max_concurrent_tasks, defaultWorkflowPreset: row.default_workflow_preset, verifyCommand: row.verify_command === null ? null : JSON.parse(row.verify_command) as string[], createdAt: row.created_at, updatedAt: row.updated_at });

export interface ProjectRepository {
  create(project: Project): Project;
  findById(id: string): Project | undefined;
  list(): Project[];
  updateStatus(id: string, status: ProjectStatus, updatedAt: string): Project;
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}
  create(project: Project): Project {
    this.db.prepare(`INSERT INTO projects (id,name,repo_path,base_branch,worktree_root,status,max_concurrent_tasks,default_workflow_preset,verify_command,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(project.id, project.name, project.repoPath, project.baseBranch, project.worktreeRoot, project.status, project.maxConcurrentTasks, project.defaultWorkflowPreset, project.verifyCommand === null ? null : JSON.stringify(project.verifyCommand), project.createdAt, project.updatedAt);
    return project;
  }
  findById(id: string): Project | undefined { const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined; return row && mapProject(row); }
  list(): Project[] { return (this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as ProjectRow[]).map(mapProject); }
  updateStatus(id: string, status: ProjectStatus, updatedAt: string): Project {
    const result = this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
    if (result.changes !== 1) throw new NotFoundError(`Project ${id} not found`);
    return this.findById(id)!;
  }
}
