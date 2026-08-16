#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase } from "../db/database.js";
import { createApplication } from "./application.js";
import { expandPreset } from "../workflows/presets.js";
import type { StepType } from "../shared/domain.js";
import { ImController } from "../im/im-controller.js";
import { TelegramAdapter } from "../im/telegram-adapter.js";
import { GitHubService } from "../github/github-service.js";
import { GhCliAdapter } from "../github/gh-cli-adapter.js";

function option(args:string[],name:string,required=true):string|undefined { const i=args.indexOf(`--${name}`); const value=i>=0?args[i+1]:undefined; if(required&&!value) throw new Error(`Missing --${name}`); return value; }
function has(args:string[],name:string):boolean { return args.includes(`--${name}`); }
function usage():never { console.error(`AgentDock V0.5
Usage:
  agentdock serve (long-running: Telegram adapter when TELEGRAM_BOT_TOKEN is set)
  agentdock migrate
  agentdock project add --name NAME --repo-path PATH --worktree-root PATH [--base-branch main] [--max-concurrent-tasks 1] [--verify-command JSON_ARGV]
  agentdock project list
  agentdock project validate --project-id ID
  agentdock project set-status --project-id ID --status ACTIVE|PAUSED|DISABLED
  agentdock task create --project-id ID --request TEXT
  agentdock task revise --task-id ID --request TEXT
  agentdock task list [--project-id ID]
  agentdock task show --task-id ID
  agentdock task prepare --task-id ID
  agentdock task cleanup --task-id ID [--force]
  agentdock task status --task-id ID
  agentdock task diff --task-id ID [--stat]
  agentdock workflow start --task-id ID --preset fast|cross-review|careful [--provider STEP=NAME ...]
  agentdock workflow execute --run-id ID
  agentdock workflow status --run-id ID
  agentdock workflow approve --run-id ID [--reject]
  agentdock workflow cancel --run-id ID
  agentdock github create-pr --task-id ID --title TEXT
  agentdock github refresh --task-id ID
  agentdock github reviews --task-id ID
  agentdock metrics summary
  agentdock metrics usage --task-id ID
  agentdock audit [--task-id ID] [--limit 50]

Set AGENTDOCK_DB to choose the database (default: .agentdock/agentdock.db).`); process.exit(1); }

function parseProviderOverrides(args:string[]): Partial<Record<StepType,string>> {
  const overrides: Partial<Record<StepType,string>> = {};
  for (let index=0;index<args.length;index++) {
    if(!args[index]!.startsWith("--provider")) continue;
    const value=args[index+1]; if(!value) throw new Error("--provider requires STEP=NAME");
    const [step,provider]=value.split("=");
    if(!step||!provider) throw new Error("--provider requires STEP=NAME");
    expandPreset("careful").some((entry)=>entry.stepType===step) || (()=>{throw new Error(`Unknown step type: ${step}`);})();
    overrides[step as StepType]=provider;
  }
  return overrides;
}

const args=process.argv.slice(2); if(args.includes("--help")||args.length===0) usage();
const db=openDatabase(resolve(process.env.AGENTDOCK_DB??"./.agentdock/agentdock.db"));
try {
  const app=createApplication(db); const [resource,action]=args;
  if(resource==="serve") {
    const telegramToken=process.env.TELEGRAM_BOT_TOKEN;
    const controller=new ImController(db,app);
    if(telegramToken) controller.register(new TelegramAdapter(telegramToken));
    await controller.startAll();
    console.log(`AgentDock serving (${telegramToken?"telegram":"no IM adapters configured"}). Ctrl-C to stop.`);
    await new Promise(()=>{});
  }
  else if(resource==="migrate") console.log("Migrations applied.");
  else if(resource==="project"&&action==="add") {
    const baseBranch=option(args,"base-branch",false);
    const verifyCommandRaw=option(args,"verify-command",false);
    const verifyCommand=verifyCommandRaw===undefined?undefined:JSON.parse(verifyCommandRaw) as string[];
    console.log(JSON.stringify(app.projects.create({name:option(args,"name")!,repoPath:option(args,"repo-path")!,worktreeRoot:option(args,"worktree-root")!,...(baseBranch === undefined ? {} : {baseBranch}),maxConcurrentTasks:Number(option(args,"max-concurrent-tasks",false)??1),...(verifyCommand===undefined?{}:{verifyCommand})}),null,2));
  }
  else if(resource==="project"&&action==="list") console.log(JSON.stringify(app.projects.list(),null,2));
  else if(resource==="project"&&action==="set-status") console.log(JSON.stringify(app.projects.setStatus(option(args,"project-id")!,option(args,"status")!),null,2));
  else if(resource==="project"&&action==="validate") { const validation=await app.worktrees.validateProject(option(args,"project-id")!); console.log(JSON.stringify(validation,null,2)); if(!validation.ok) process.exitCode=1; }
  else if(resource==="task"&&action==="create") console.log(JSON.stringify(app.tasks.create(option(args,"project-id")!,option(args,"request")!),null,2));
  else if(resource==="task"&&action==="revise") console.log(JSON.stringify(app.tasks.revise(option(args,"task-id")!,option(args,"request")!),null,2));
  else if(resource==="task"&&action==="list") console.log(JSON.stringify(app.tasks.list(option(args,"project-id",false)),null,2));
  else if(resource==="task"&&action==="show") console.log(JSON.stringify(app.tasks.show(option(args,"task-id")!),null,2));
  else if(resource==="task"&&action==="prepare") console.log(JSON.stringify(await app.worktrees.prepare(option(args,"task-id")!),null,2));
  else if(resource==="task"&&action==="cleanup") console.log(JSON.stringify(await app.worktrees.cleanup(option(args,"task-id")!,{force:has(args,"force")}),null,2));
  else if(resource==="task"&&action==="status") console.log(JSON.stringify(await app.worktrees.status(option(args,"task-id")!),null,2));
  else if(resource==="task"&&action==="diff") console.log(await app.worktrees.diff(option(args,"task-id")!,{stat:has(args,"stat")}));
  else if(resource==="workflow"&&action==="start") console.log(JSON.stringify(await app.workflows.start({taskId:option(args,"task-id")!,preset:option(args,"preset")!,providers:parseProviderOverrides(args)}),null,2));
  else if(resource==="workflow"&&action==="execute") console.log(JSON.stringify(await app.workflows.execute(option(args,"run-id")!),null,2));
  else if(resource==="workflow"&&action==="status") console.log(JSON.stringify(app.workflows.status(option(args,"run-id")!),null,2));
  else if(resource==="workflow"&&action==="approve") console.log(JSON.stringify(app.workflows.approve(option(args,"run-id")!,!has(args,"reject")),null,2));
  else if(resource==="workflow"&&action==="cancel") console.log(JSON.stringify(app.workflows.cancel(option(args,"run-id")!),null,2));
  else if(resource==="github"&&action==="create-pr") {
    const github=new GitHubService(db,new GhCliAdapter(),app.repositories.tasks,app.repositories.projects);
    console.log(JSON.stringify(await github.createDraftPr({taskId:option(args,"task-id")!,title:option(args,"title")!}),null,2));
  }
  else if(resource==="github"&&action==="refresh") {
    const github=new GitHubService(db,new GhCliAdapter(),app.repositories.tasks,app.repositories.projects);
    console.log(JSON.stringify(await github.refresh(option(args,"task-id")!),null,2));
  }
  else if(resource==="github"&&action==="reviews") {
    const github=new GitHubService(db,new GhCliAdapter(),app.repositories.tasks,app.repositories.projects);
    console.log(JSON.stringify(await github.ingestReviews(option(args,"task-id")!),null,2));
  }
  else if(resource==="metrics"&&action==="summary") console.log(JSON.stringify({steps:app.metrics.stepMetrics(),tasks:app.metrics.taskMetrics()},null,2));
  else if(resource==="metrics"&&action==="usage") console.log(JSON.stringify(app.metrics.usageForTask(option(args,"task-id")!),null,2));
  else if(resource==="audit") { const taskId=option(args,"task-id",false); console.log(JSON.stringify(app.audit.list({...(taskId===undefined?{}:{taskId}),limit:Number(option(args,"limit",false)??50)}),null,2)); }
  else usage();
} catch(error) { console.error(error instanceof Error?error.message:error); process.exitCode=1; } finally { db.close(); }
