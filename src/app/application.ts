import type { Database } from "../db/database.js";
import { SqliteProjectRepository } from "../projects/project-repository.js";
import { ProjectService } from "../projects/project-service.js";
import { SqliteTaskRepository } from "../tasks/task-repository.js";
import { TaskService } from "../tasks/task-service.js";
import { SqliteWorkflowRepository } from "../workflows/workflow-repository.js";
import { SqliteAgentThreadRepository } from "../agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../artifacts/artifact-repository.js";
import { GitService } from "../git/git-service.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { ProcessRunner } from "../runtime/process-runner.js";
import { ClaudeAgent, CodexAgent } from "../runtime/env-agents.js";
import type { CodingAgent } from "../runtime/coding-agent.js";
import { AgentThreadManager } from "../runtime/agent-thread-manager.js";
import { resolve } from "node:path";

export function createApplication(db:Database) {
  const projectRepository=new SqliteProjectRepository(db); const taskRepository=new SqliteTaskRepository(db); const git=new GitService();
  const workflowRepository=new SqliteWorkflowRepository(db); const agentThreadRepository=new SqliteAgentThreadRepository(db); const artifactRepository=new SqliteArtifactRepository(db);
  const runner=new ProcessRunner();
  const agents:Record<string,CodingAgent>={claude:new ClaudeAgent(runner),codex:new CodexAgent(runner)};
  const artifactRoot=resolve(process.env.AGENTDOCK_ARTIFACTS??"./.agentdock/artifacts");
  return {
    projects:new ProjectService(projectRepository),
    tasks:new TaskService(taskRepository,projectRepository),
    worktrees:new WorktreeManager(taskRepository,projectRepository,git),
    runtime:new AgentThreadManager(agentThreadRepository,artifactRepository,taskRepository,(provider)=>{ const agent=agents[provider]; if(!agent) throw new Error(`Unknown agent provider: ${provider}`); return agent; },artifactRoot),
    repositories:{projects:projectRepository,tasks:taskRepository,workflows:workflowRepository,agentThreads:agentThreadRepository,artifacts:artifactRepository},
  };
}
