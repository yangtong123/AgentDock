import { randomUUID } from "node:crypto";
import type { Project, ProjectStatus } from "../shared/domain.js";
import { NotFoundError, ValidationError, PROJECT_STATUSES } from "../shared/domain.js";
import type { ProjectRepository } from "./project-repository.js";

export interface CreateProjectInput { name: string; repoPath: string; baseBranch?: string; worktreeRoot: string; status?: ProjectStatus; maxConcurrentTasks?: number; defaultWorkflowPreset?: string | null; verifyCommand?: string[] | null; }
export class ProjectService {
  constructor(private readonly projects: ProjectRepository, private readonly now = () => new Date().toISOString()) {}
  create(input: CreateProjectInput): Project {
    if (!input.name.trim() || !input.repoPath.trim() || !input.worktreeRoot.trim()) throw new ValidationError("name, repoPath, and worktreeRoot are required");
    if ((input.maxConcurrentTasks ?? 1) < 1) throw new ValidationError("maxConcurrentTasks must be positive");
    if (input.verifyCommand !== undefined && input.verifyCommand !== null && (input.verifyCommand.length === 0 || input.verifyCommand.some((part) => !part.trim()))) throw new ValidationError("verifyCommand must be a non-empty argv array");
    const timestamp = this.now();
    return this.projects.create({ id: randomUUID(), name: input.name.trim(), repoPath: input.repoPath, baseBranch: input.baseBranch?.trim() || "main", worktreeRoot: input.worktreeRoot, status: input.status ?? "ACTIVE", maxConcurrentTasks: input.maxConcurrentTasks ?? 1, defaultWorkflowPreset: input.defaultWorkflowPreset ?? null, verifyCommand: input.verifyCommand ?? null, createdAt: timestamp, updatedAt: timestamp });
  }
  list(): Project[] { return this.projects.list(); }
  setStatus(projectId: string, status: string): Project {
    if (!PROJECT_STATUSES.includes(status as ProjectStatus)) throw new ValidationError(`status must be one of ${PROJECT_STATUSES.join(", ")}`);
    if (!this.projects.findById(projectId)) throw new NotFoundError(`Project ${projectId} not found`);
    return this.projects.updateStatus(projectId, status as ProjectStatus, this.now());
  }
}
