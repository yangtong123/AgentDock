#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase, withImmediateTransaction } from "../db/database.js";
import { createApplication } from "./application.js";
import { expandPreset } from "../workflows/presets.js";
import type { StepType } from "../shared/domain.js";
import { ImController } from "../im/im-controller.js";
import { TelegramAdapter } from "../im/telegram-adapter.js";
import { FeishuAdapter } from "../im/feishu-adapter.js";
import { FeishuWsAdapter } from "../im/feishu-ws-adapter.js";
import { GitHubService } from "../github/github-service.js";
import { GhCliAdapter } from "../github/gh-cli-adapter.js";
import { Orchestrator } from "../reliability/orchestrator.js";
import { OutboxDispatcher } from "../reliability/outbox-dispatcher.js";
import { TransactionalOutbox } from "../reliability/outbox.js";
import { TaskQueue } from "../reliability/task-queue.js";

function option(args:string[],name:string,required=true):string|undefined { const i=args.indexOf(`--${name}`); const value=i>=0?args[i+1]:undefined; if(required&&!value) throw new Error(`Missing --${name}`); return value; }
function has(args:string[],name:string):boolean { return args.includes(`--${name}`); }
function usage():never { console.error(`AgentDock V1.0
Usage:
  agentdock serve (long-running: Telegram adapter when TELEGRAM_BOT_TOKEN is set)
  agentdock migrate
  agentdock project add --name NAME --repo-path PATH --worktree-root PATH [--base-branch main] [--max-concurrent-tasks 1] [--verify-command JSON_ARGV] [--permission-profile default|restricted|sandboxed|full-access]
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
  agentdock workflow start --task-id ID --preset fast|cross-review|careful|fix [--provider STEP=NAME ...]
  agentdock workflow execute --run-id ID
  agentdock workflow status --run-id ID
  agentdock workflow approve --run-id ID [--reject]
  agentdock workflow cancel --run-id ID
  agentdock github create-pr --task-id ID --title TEXT
  agentdock github refresh --task-id ID
  agentdock github reviews --task-id ID
  agentdock github fix --task-id ID (reopen + start fix workflow for CI/review failures)
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
    const feishuAppId=process.env.FEISHU_APP_ID;
    const feishuAppSecret=process.env.FEISHU_APP_SECRET;
    const feishuPort=Number(process.env.FEISHU_WEBHOOK_PORT??0);
    const controller=new ImController(db,app);
    if(telegramToken) controller.register(new TelegramAdapter(telegramToken));
    // Feishu: long connection (App ID + Secret, no public URL needed) is the
    // simple mode; the webhook transport remains for setups that prefer it.
    let feishuMode: string | null = null;
    if(feishuAppId && feishuAppSecret) { controller.register(new FeishuWsAdapter(feishuAppId, feishuAppSecret)); feishuMode = "feishu(ws)"; }
    else if(feishuPort>0) { controller.register(new FeishuAdapter(feishuPort,undefined,process.env.FEISHU_VERIFICATION_TOKEN??null,()=>process.env.FEISHU_TENANT_TOKEN??null)); feishuMode = "feishu(webhook)"; }
    if((feishuAppId===undefined)!==(feishuAppSecret===undefined)) console.error("Warning: FEISHU_APP_ID and FEISHU_APP_SECRET must be set together; falling back.");
    // The orchestrator owns execution: leases, concurrency, timeouts, recovery.
    const orchestrator=new Orchestrator(db,app,app.processRunner,{});
    controller.attachOrchestrator(orchestrator);
    // Outbox delivery: terminal run events notify the IM conversation that started the task.
    const dispatcher=new OutboxDispatcher(db,new TransactionalOutbox(db),(conversationId,text,adapter)=>controller.notify(conversationId,text,adapter),"serve-dispatcher");
    controller.attachNotifier(dispatcher);
    await controller.startAll();
    await orchestrator.start();
    await dispatcher.start();
    const adapters=[telegramToken?"telegram":null,feishuMode].filter(Boolean).join("+")||"no IM adapters configured";
    console.log(`AgentDock serving (${adapters}). Ctrl-C to stop.`);
    const shutdown=async()=>{ await dispatcher.stop(); await orchestrator.stop(); await controller.stopAll(); db.close(); process.exit(0); };
    process.on("SIGINT",()=>{ void shutdown(); });
    process.on("SIGTERM",()=>{ void shutdown(); });
    await new Promise(()=>{});
  }
  else if(resource==="migrate") console.log("Migrations applied.");
  else if(resource==="project"&&action==="add") {
    const baseBranch=option(args,"base-branch",false);
    const verifyCommandRaw=option(args,"verify-command",false);
    const verifyCommand=verifyCommandRaw===undefined?undefined:JSON.parse(verifyCommandRaw) as string[];
    const permissionProfile=option(args,"permission-profile",false);
    if(permissionProfile!==undefined&&!["default","restricted","sandboxed","full-access"].includes(permissionProfile)) throw new Error("permission-profile must be default, restricted, sandboxed, or full-access");
    console.log(JSON.stringify(app.projects.create({name:option(args,"name")!,repoPath:option(args,"repo-path")!,worktreeRoot:option(args,"worktree-root")!,...(baseBranch === undefined ? {} : {baseBranch}),maxConcurrentTasks:Number(option(args,"max-concurrent-tasks",false)??1),...(verifyCommand===undefined?{}:{verifyCommand}),...(permissionProfile===undefined?{}:{permissionProfile})}),null,2));
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
  else if(resource==="workflow"&&action==="start") {
    // Start + enqueue commit atomically: a running serve must never see a
    // QUEUED run without its queue entry (it would be recovered as an orphan).
    const started=withImmediateTransaction(db,()=>{
      const s=app.workflows.start({taskId:option(args,"task-id")!,preset:option(args,"preset")!,providers:parseProviderOverrides(args)});
      new TaskQueue(db).enqueue(option(args,"task-id")!);
      return s;
    });
    console.log(JSON.stringify(started,null,2));
  }
  else if(resource==="workflow"&&action==="execute") {
    // CLI execution joins the orchestrator protocol: scheduling gate (project
    // ACTIVE), lease with heartbeats, active-run validation — so inline runs
    // are neither reaped as orphans nor bypass the orchestrator's rules.
    const runId=option(args,"run-id")!;
    const row=db.prepare("SELECT tr.task_id AS taskId FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE wr.id = ?").get(runId) as {taskId:string}|undefined;
    const taskId=row?.taskId??null;
    const orchestrator=new Orchestrator(db,app,app.processRunner,{});
    const LEASE_TTL_MS=60_000;
    const claim=taskId!==null?orchestrator.claimInlineRun(taskId,runId,`cli-${process.pid}`,LEASE_TTL_MS):null;
    let leaseLost=false;
    let lastRenewedAt=Date.now();
    const heartbeat=claim!==null?setInterval(()=>{
      if(leaseLost) return;
      const state=claim.heartbeat();
      if(state==="ok") { lastRenewedAt=Date.now(); return; }
      // "lost" cancels immediately; "unknown" (transient DB error) only after a
      // full TTL without a successful renewal — a single busy hiccup must not
      // kill a healthy multi-hour run.
      if(state==="lost"||Date.now()-lastRenewedAt>=LEASE_TTL_MS){ leaseLost=true; app.processRunner.cancelOwner(taskId!); }
    },15_000):null;
    try {
      try {
        console.log(JSON.stringify(await app.workflows.execute(runId),null,2));
      } catch (error) {
        // Surface the operator-meaningful cause, not the raw process error.
        if(leaseLost) throw new Error(`Lease for task ${taskId} was lost mid-execution; the run was cancelled`);
        throw error;
      }
      if(leaseLost) throw new Error(`Lease for task ${taskId} was lost mid-execution; the run was cancelled`);
    } finally {
      if(heartbeat!==null) clearInterval(heartbeat);
      claim?.release();
    }
  }
  else if(resource==="workflow"&&action==="status") console.log(JSON.stringify(app.workflows.status(option(args,"run-id")!),null,2));
  else if(resource==="workflow"&&action==="approve") {
    // Approve + enqueue atomically, mirroring the IM approval path.
    const runId=option(args,"run-id")!;
    const approved=!has(args,"reject");
    withImmediateTransaction(db,()=>{
      app.workflows.approve(runId,approved);
      if(approved) {
        const row=db.prepare("SELECT tr.task_id AS taskId FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE wr.id = ?").get(runId) as {taskId:string}|undefined;
        if(row!==undefined) new TaskQueue(db).enqueue(row.taskId);
      }
    });
    console.log(JSON.stringify(app.workflows.status(runId),null,2));
  }
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
  else if(resource==="github"&&action==="fix") {
    const github=new GitHubService(db,new GhCliAdapter(),app.repositories.tasks,app.repositories.projects);
    const taskId=option(args,"task-id")!;
    const { runId, triggerCount }=withImmediateTransaction(db,()=>{
      const result=github.startFixWorkflow(taskId,(input)=>app.workflows.start(input));
      new TaskQueue(db).enqueue(taskId);
      return result;
    });
    console.log(JSON.stringify({runId,triggerCount,queued:true,hint:"a running serve will pick it up; or run: agentdock workflow execute --run-id "+runId},null,2));
  }
  else if(resource==="metrics"&&action==="summary") console.log(JSON.stringify({steps:app.metrics.stepMetrics(),tasks:app.metrics.taskMetrics()},null,2));
  else if(resource==="metrics"&&action==="usage") console.log(JSON.stringify(app.metrics.usageForTask(option(args,"task-id")!),null,2));
  else if(resource==="audit") { const taskId=option(args,"task-id",false); console.log(JSON.stringify(app.audit.list({...(taskId===undefined?{}:{taskId}),limit:Number(option(args,"limit",false)??50)}),null,2)); }
  else usage();
} catch(error) { console.error(error instanceof Error?error.message:error); process.exitCode=1; } finally { db.close(); }
