#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase } from "../db/database.js";
import { createApplication } from "./application.js";

function option(args:string[],name:string,required=true):string|undefined { const i=args.indexOf(`--${name}`); const value=i>=0?args[i+1]:undefined; if(required&&!value) throw new Error(`Missing --${name}`); return value; }
function has(args:string[],name:string):boolean { return args.includes(`--${name}`); }
function usage():never { console.error(`AgentDock V0.2
Usage:
  agentdock migrate
  agentdock project add --name NAME --repo-path PATH --worktree-root PATH [--base-branch main] [--max-concurrent-tasks 1]
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

Set AGENTDOCK_DB to choose the database (default: .agentdock/agentdock.db).`); process.exit(1); }

const args=process.argv.slice(2); if(args.includes("--help")||args.length===0) usage();
const db=openDatabase(resolve(process.env.AGENTDOCK_DB??".agentdock/agentdock.db"));
try {
  const app=createApplication(db); const [resource,action]=args;
  if(resource==="migrate") console.log("Migrations applied.");
  else if(resource==="project"&&action==="add") {
    const baseBranch=option(args,"base-branch",false);
    console.log(JSON.stringify(app.projects.create({name:option(args,"name")!,repoPath:option(args,"repo-path")!,worktreeRoot:option(args,"worktree-root")!,...(baseBranch === undefined ? {} : {baseBranch}),maxConcurrentTasks:Number(option(args,"max-concurrent-tasks",false)??1)}),null,2));
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
  else usage();
} catch(error) { console.error(error instanceof Error?error.message:error); process.exitCode=1; } finally { db.close(); }
