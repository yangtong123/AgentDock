import { randomUUID } from "node:crypto";
import type { Task, TaskDetails, TaskRevision } from "../shared/domain.js";
import { NotFoundError, StateConflictError, ValidationError } from "../shared/domain.js";
import type { Database } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import type { ProjectRepository } from "../projects/project-repository.js";
import type { TaskRepository } from "./task-repository.js";

export class TaskService {
  constructor(private readonly tasks: TaskRepository, private readonly projects: ProjectRepository, private readonly db?: Database, private readonly now = () => new Date().toISOString()) {}
  create(projectId: string, request: string): TaskDetails {
    if (!this.projects.findById(projectId)) throw new NotFoundError(`Project ${projectId} not found`);
    if (!request.trim()) throw new ValidationError("request is required");
    const timestamp=this.now();
    const task:Task={id:randomUUID(),projectId,state:"DRAFT",currentRevision:1,branch:null,worktreePath:null,createdAt:timestamp,updatedAt:timestamp};
    const revision:TaskRevision={id:randomUUID(),taskId:task.id,revision:1,request:request.trim(),createdAt:timestamp};
    this.tasks.createWithRevision(task,revision); return {task,currentRevision:revision,revisions:[revision]};
  }
  /** New revision = new work requested. A terminal task reopens to READY so a
   *  follow-up revision can start a fresh run (runs stay pinned to old revisions).
   *  RUNNING/CANCEL_REQUESTED tasks keep their state: the in-flight run owns it.
   *  The revision append and the conditional reopen commit in ONE transaction
   *  with the state re-read inside it: across connections, a concurrent retry
   *  that flips the task to RUNNING between read and write would otherwise be
   *  overwritten back to READY, allowing a second concurrent run. */
  revise(taskId:string,request:string):TaskRevision {
    if(!request.trim()) throw new ValidationError("request is required");
    const initial=this.tasks.findById(taskId); if(!initial) throw new NotFoundError(`Task ${taskId} not found`);
    const timestamp=this.now(); const revision:TaskRevision={id:randomUUID(),taskId,revision:initial.currentRevision+1,request:request.trim(),createdAt:timestamp};
    const apply=():void=>{
      this.tasks.addRevision(taskId,revision,timestamp);
      const state=this.tasks.findById(taskId)!.state;
      if(state==="SUCCEEDED"||state==="FAILED"||state==="CANCELLED") this.tasks.update(taskId,{state:"READY"},timestamp);
    };
    // Joins the caller's transaction when one is open (command layer); opens
    // its own for direct service callers.
    if(this.db!==undefined) withImmediateTransaction(this.db,apply); else apply();
    return revision;
  }
  show(taskId:string):TaskDetails { const task=this.tasks.findById(taskId); if(!task) throw new NotFoundError(`Task ${taskId} not found`); const revisions=this.tasks.listRevisions(taskId); const currentRevision=revisions.find(r=>r.revision===task.currentRevision); if(!currentRevision) throw new Error("Task has no current revision"); return {task,currentRevision,revisions}; }
  list(projectId?:string):Task[] { return this.tasks.list(projectId); }
  /** Reopens a finished task for a retry run: same revision, back to READY. */
  reopenForRetry(taskId:string):Task {
    const task=this.tasks.findById(taskId); if(!task) throw new NotFoundError(`Task ${taskId} not found`);
    if(task.state!=="FAILED"&&task.state!=="CANCELLED") throw new StateConflictError(`Task ${taskId} is ${task.state}; only FAILED or CANCELLED tasks can be reopened for retry`);
    return this.tasks.update(taskId,{state:"READY"},this.now());
  }
}
