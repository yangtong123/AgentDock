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
import { WorkflowEngine } from "../workflows/workflow-engine.js";
import { MetricsService, BudgetGuard } from "../security/metrics.js";
import { AuditLog } from "../security/permissions.js";
import { GitHubService } from "../github/github-service.js";
import { GhCliAdapter } from "../github/gh-cli-adapter.js";
import { resolve } from "node:path";

export type Application = ReturnType<typeof createApplication>;

export function createApplication(db:Database, options:{ agents?: Record<string, CodingAgent> } = {}) {
  const projectRepository=new SqliteProjectRepository(db); const taskRepository=new SqliteTaskRepository(db); const git=new GitService();
  const workflowRepository=new SqliteWorkflowRepository(db); const agentThreadRepository=new SqliteAgentThreadRepository(db); const artifactRepository=new SqliteArtifactRepository(db);
  const runner=new ProcessRunner();
  const agents:Record<string,CodingAgent>=options.agents??{claude:new ClaudeAgent(runner),codex:new CodexAgent(runner)};
  const artifactRoot=resolve(process.env.AGENTDOCK_ARTIFACTS??"./.agentdock/artifacts");
  const runtime=new AgentThreadManager(agentThreadRepository,artifactRepository,taskRepository,(provider)=>{ const agent=agents[provider]; if(!agent) throw new Error(`Unknown agent provider: ${provider}`); return agent; },artifactRoot);
  const tasks=new TaskService(taskRepository,projectRepository);
  const worktrees=new WorktreeManager(taskRepository,projectRepository,git);
  const metrics=new MetricsService(db);
  const budget=new BudgetGuard(db,metrics);
  const github=new GitHubService(db,new GhCliAdapter(),taskRepository,projectRepository);
  return {
    projects:new ProjectService(projectRepository),
    tasks,
    worktrees,
    runtime,
    // FIX prompts consume GitHub CI/review triggers; every step records durations,
    // usage, and budget checks so V0.9 observability is live in real runs.
    workflows:new WorkflowEngine(workflowRepository,taskRepository,projectRepository,runtime,artifactRepository,runner,process.env,undefined,(taskId)=>github.fixInstructions(taskId),{
      metrics,
      usage:(entry)=>metrics.recordUsage(entry),
      budgetGuard:(taskId)=>budget.withinBudget(taskId,{maxStepsPerTask:100,maxDurationMsPerTask:8*60*60*1000}),
    }),
    /** Shared runner so cancellation reaches the same processes the app spawned. */
    processRunner:runner,
    metrics,
    budget,
    audit:new AuditLog(db),
    github,
    repositories:{projects:projectRepository,tasks:taskRepository,workflows:workflowRepository,agentThreads:agentThreadRepository,artifacts:artifactRepository},
  };
}
