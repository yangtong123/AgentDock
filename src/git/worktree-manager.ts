import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project, Task } from "../shared/domain.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { GitService, WorktreeEntry } from "./git-service.js";

export interface TaskGitStatus { taskId: string; branch: string; baseBranch: string; headSha: string; baseSha: string; files: { status: string; path: string }[] }
export interface ProjectValidation { projectId: string; ok: boolean; issues: string[] }

function normalizePath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }

export class WorktreeManager {
  constructor(private readonly tasks: TaskRepository, private readonly projects: ProjectRepository, private readonly git: GitService, private readonly now = () => new Date().toISOString()) {}

  private context(taskId: string): { task: Task; project: Project } {
    const task = this.tasks.findById(taskId); if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    const project = this.projects.findById(task.projectId); if (!project) throw new NotFoundError(`Project ${task.projectId} not found`);
    return { task, project };
  }

  private async worktreeFor(repoPath: string, worktreePath: string): Promise<WorktreeEntry | undefined> {
    const normalized = normalizePath(worktreePath);
    return (await this.git.worktreeList(repoPath)).find((entry) => normalizePath(entry.path) === normalized);
  }

  private async assertRepositoryUsable(project: Project): Promise<void> {
    if (!(await this.git.isWorkTree(project.repoPath))) throw new ValidationError(`${project.repoPath} is not a Git work tree`);
    if (!(await this.git.branchExists(project.baseBranch, project.repoPath))) throw new ValidationError(`Base branch ${project.baseBranch} not found in ${project.repoPath}`);
  }

  async prepare(taskId: string): Promise<Task> {
    const { task, project } = this.context(taskId);
    if (project.status !== "ACTIVE") throw new ValidationError(`Project ${project.name} is ${project.status}; tasks can only be prepared for ACTIVE projects`);
    const branch = task.branch ?? `agentdock/${task.id}`;
    const worktreePath = task.worktreePath ?? join(project.worktreeRoot, task.id);
    if (task.state === "READY" && task.worktreePath && task.branch) {
      if (existsSync(worktreePath) && (await this.worktreeFor(project.repoPath, worktreePath)) !== undefined) return task;
      await this.git.worktreePrune(project.repoPath);
    } else if (task.state !== "DRAFT") throw new ValidationError(`Task ${taskId} is ${task.state} and cannot be prepared`);
    await this.assertRepositoryUsable(project);
    mkdirSync(project.worktreeRoot, { recursive: true });
    // Git is the source of truth: a previous run may have created the worktree and branch but died before the database update.
    const alreadyAttached = existsSync(worktreePath) && (await this.worktreeFor(project.repoPath, worktreePath))?.branch === `refs/heads/${branch}`;
    if (!alreadyAttached) {
      if (await this.git.branchExists(branch, project.repoPath)) await this.git.worktreeAdd(worktreePath, branch, project.repoPath);
      else await this.git.worktreeAdd(worktreePath, branch, project.repoPath, project.baseBranch);
    }
    return this.tasks.update(taskId, { state: "READY", branch, worktreePath }, this.now());
  }

  async cleanup(taskId: string, options: { force?: boolean } = {}): Promise<Task> {
    const { task, project } = this.context(taskId);
    if (!task.worktreePath || !task.branch) throw new ValidationError(`Task ${taskId} has no worktree to clean up`);
    const force = options.force === true;
    // Check for unmerged commits before destroying anything so a refused cleanup leaves no partial state behind.
    // This rev-list check (not `git branch -d`, which judges against the current HEAD) is the authority for base-branch merge safety.
    const branchExists = await this.git.branchExists(task.branch, project.repoPath);
    if (branchExists && !force) {
      const unmerged = await this.git.revListCount(project.baseBranch, task.branch, project.repoPath);
      if (unmerged > 0) throw new ValidationError(`Branch ${task.branch} has ${unmerged} commit(s) not merged into ${project.baseBranch}; pass --force to discard them`);
    }
    if (existsSync(task.worktreePath) && (await this.worktreeFor(project.repoPath, task.worktreePath)) !== undefined) await this.git.worktreeRemove(task.worktreePath, project.repoPath, force);
    else await this.git.worktreePrune(project.repoPath);
    if (branchExists) await this.git.deleteBranch(task.branch, project.repoPath);
    return this.tasks.update(taskId, { state: "DRAFT", branch: null, worktreePath: null }, this.now());
  }

  async status(taskId: string): Promise<TaskGitStatus> {
    const { task, project } = this.context(taskId);
    if (!task.worktreePath || !task.branch) throw new ValidationError(`Task ${taskId} has no worktree`);
    const files = await this.git.statusEntries(task.worktreePath);
    return { taskId, branch: task.branch, baseBranch: project.baseBranch, headSha: await this.git.headSha(task.worktreePath), baseSha: await this.git.mergeBase(project.baseBranch, task.worktreePath), files };
  }

  async diff(taskId: string, options: { stat?: boolean } = {}): Promise<string> {
    const { task, project } = this.context(taskId);
    if (!task.worktreePath) throw new ValidationError(`Task ${taskId} has no worktree`);
    const baseSha = await this.git.mergeBase(project.baseBranch, task.worktreePath);
    return this.git.diff(baseSha, task.worktreePath, options.stat === true);
  }

  async validateProject(projectId: string): Promise<ProjectValidation> {
    const project = this.projects.findById(projectId); if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    const issues: string[] = [];
    if (!(await this.git.isWorkTree(project.repoPath))) issues.push(`${project.repoPath} is not a Git work tree`);
    if (!(await this.git.branchExists(project.baseBranch, project.repoPath))) issues.push(`base branch ${project.baseBranch} not found in ${project.repoPath}`);
    try { mkdirSync(project.worktreeRoot, { recursive: true }); } catch (error) { issues.push(`worktree root ${project.worktreeRoot} is not usable: ${error instanceof Error ? error.message : String(error)}`); }
    return { projectId, ok: issues.length === 0, issues };
  }
}
