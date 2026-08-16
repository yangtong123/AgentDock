import type { Database } from "../db/database.js";
import { SqliteProjectRepository } from "../projects/project-repository.js";
import { ProjectService } from "../projects/project-service.js";
import { SqliteTaskRepository } from "../tasks/task-repository.js";
import { TaskService } from "../tasks/task-service.js";
import { SqliteWorkflowRepository } from "../workflows/workflow-repository.js";
import { SqliteAgentThreadRepository } from "../agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../artifacts/artifact-repository.js";

export function createApplication(db:Database) {
  const projectRepository=new SqliteProjectRepository(db); const taskRepository=new SqliteTaskRepository(db);
  return { projects:new ProjectService(projectRepository), tasks:new TaskService(taskRepository,projectRepository), repositories:{projects:projectRepository,tasks:taskRepository,workflows:new SqliteWorkflowRepository(db),agentThreads:new SqliteAgentThreadRepository(db),artifacts:new SqliteArtifactRepository(db)} };
}
