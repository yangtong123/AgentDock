import type { Database } from "../db/database.js";
import type { RunState, StepRun, StepType, WorkflowRun } from "../shared/domain.js";
type WorkflowRow={id:string;task_revision_id:string;preset:string|null;state:RunState;created_at:string;updated_at:string};
type StepRow={id:string;workflow_run_id:string;step_type:StepType;state:RunState;provider:string|null;sequence:number;created_at:string;updated_at:string};
export interface WorkflowRepository { createRun(run:WorkflowRun):WorkflowRun; findRun(id:string):WorkflowRun|undefined; createStep(step:StepRun):StepRun; listSteps(workflowRunId:string):StepRun[]; }
export class SqliteWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db:Database){}
  createRun(r:WorkflowRun):WorkflowRun { this.db.prepare("INSERT INTO workflow_runs (id,task_revision_id,preset,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(r.id,r.taskRevisionId,r.preset,r.state,r.createdAt,r.updatedAt); return r; }
  findRun(id:string):WorkflowRun|undefined { const r=this.db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(id) as WorkflowRow|undefined; return r&&{id:r.id,taskRevisionId:r.task_revision_id,preset:r.preset,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at}; }
  createStep(s:StepRun):StepRun { this.db.prepare("INSERT INTO step_runs (id,workflow_run_id,step_type,state,provider,sequence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(s.id,s.workflowRunId,s.stepType,s.state,s.provider,s.sequence,s.createdAt,s.updatedAt); return s; }
  listSteps(id:string):StepRun[] { return (this.db.prepare("SELECT * FROM step_runs WHERE workflow_run_id=? ORDER BY sequence").all(id) as StepRow[]).map(r=>({id:r.id,workflowRunId:r.workflow_run_id,stepType:r.step_type,state:r.state,provider:r.provider,sequence:r.sequence,createdAt:r.created_at,updatedAt:r.updated_at})); }
}
