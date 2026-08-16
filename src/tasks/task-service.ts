import { randomUUID } from "node:crypto";
import type { Task, TaskDetails, TaskRevision } from "../shared/domain.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import type { TaskRepository } from "./task-repository.js";

export class TaskService {
  constructor(private readonly tasks: TaskRepository, private readonly projects: ProjectRepository, private readonly now = () => new Date().toISOString()) {}
  create(projectId: string, request: string): TaskDetails {
    if (!this.projects.findById(projectId)) throw new NotFoundError(`Project ${projectId} not found`);
    if (!request.trim()) throw new ValidationError("request is required");
    const timestamp=this.now();
    const task:Task={id:randomUUID(),projectId,state:"DRAFT",currentRevision:1,branch:null,worktreePath:null,createdAt:timestamp,updatedAt:timestamp};
    const revision:TaskRevision={id:randomUUID(),taskId:task.id,revision:1,request:request.trim(),createdAt:timestamp};
    this.tasks.createWithRevision(task,revision); return {task,currentRevision:revision,revisions:[revision]};
  }
  revise(taskId:string,request:string):TaskRevision {
    if(!request.trim()) throw new ValidationError("request is required");
    const task=this.tasks.findById(taskId); if(!task) throw new NotFoundError(`Task ${taskId} not found`);
    const timestamp=this.now(); const revision:TaskRevision={id:randomUUID(),taskId,revision:task.currentRevision+1,request:request.trim(),createdAt:timestamp};
    this.tasks.addRevision(taskId,revision,timestamp); return revision;
  }
  show(taskId:string):TaskDetails { const task=this.tasks.findById(taskId); if(!task) throw new NotFoundError(`Task ${taskId} not found`); const revisions=this.tasks.listRevisions(taskId); const currentRevision=revisions.find(r=>r.revision===task.currentRevision); if(!currentRevision) throw new Error("Task has no current revision"); return {task,currentRevision,revisions}; }
  list(projectId?:string):Task[] { return this.tasks.list(projectId); }
}
