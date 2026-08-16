import type { Database } from "../db/database.js";
import type { AgentThread } from "../shared/domain.js";
import { NotFoundError } from "../shared/domain.js";
type Row={id:string;task_id:string;provider:string;role:string;external_session_id:string|null;created_at:string;updated_at:string};
const map=(r:Row):AgentThread=>({id:r.id,taskId:r.task_id,provider:r.provider,role:r.role,externalSessionId:r.external_session_id,createdAt:r.created_at,updatedAt:r.updated_at});
export interface AgentThreadRepository { create(thread:AgentThread):AgentThread; findById(id:string):AgentThread|undefined; listForTask(taskId:string):AgentThread[]; updateSessionId(id:string,externalSessionId:string,updatedAt:string):AgentThread; }
export class SqliteAgentThreadRepository implements AgentThreadRepository {
  constructor(private readonly db:Database){}
  create(t:AgentThread):AgentThread { this.db.prepare("INSERT INTO agent_threads (id,task_id,provider,role,external_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(t.id,t.taskId,t.provider,t.role,t.externalSessionId,t.createdAt,t.updatedAt); return t; }
  findById(id:string):AgentThread|undefined { const r=this.db.prepare("SELECT * FROM agent_threads WHERE id=?").get(id) as Row|undefined; return r&&map(r); }
  listForTask(id:string):AgentThread[] { return (this.db.prepare("SELECT * FROM agent_threads WHERE task_id=? ORDER BY created_at,id").all(id) as Row[]).map(map); }
  updateSessionId(id:string,externalSessionId:string,updatedAt:string):AgentThread { const result=this.db.prepare("UPDATE agent_threads SET external_session_id=?,updated_at=? WHERE id=?").run(externalSessionId,updatedAt,id); if(result.changes!==1) throw new NotFoundError(`AgentThread ${id} not found`); return this.findById(id)!; }
}
