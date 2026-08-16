import type { Database } from "../db/database.js";
import type { Artifact } from "../shared/domain.js";
type Row={id:string;task_id:string;workflow_run_id:string|null;step_run_id:string|null;kind:string;name:string;storage_type:"INLINE"|"FILE";content:string|null;path:string|null;created_at:string};
const map=(r:Row):Artifact=>({id:r.id,taskId:r.task_id,workflowRunId:r.workflow_run_id,stepRunId:r.step_run_id,kind:r.kind,name:r.name,storage:r.storage_type==="INLINE"?{type:"INLINE",content:r.content!}:{type:"FILE",path:r.path!},createdAt:r.created_at});
export interface ArtifactRepository { create(artifact:Artifact):Artifact; findById(id:string):Artifact|undefined; listForTask(taskId:string):Artifact[]; }
export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly db:Database){}
  create(a:Artifact):Artifact { this.db.prepare("INSERT INTO artifacts (id,task_id,workflow_run_id,step_run_id,kind,name,storage_type,content,path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(a.id,a.taskId,a.workflowRunId,a.stepRunId,a.kind,a.name,a.storage.type,a.storage.type==="INLINE"?a.storage.content:null,a.storage.type==="FILE"?a.storage.path:null,a.createdAt); return a; }
  findById(id:string):Artifact|undefined { const r=this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as Row|undefined; return r&&map(r); }
  listForTask(id:string):Artifact[] { return (this.db.prepare("SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at,id").all(id) as Row[]).map(map); }
}
