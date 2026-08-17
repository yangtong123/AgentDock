import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";

function temporaryDatabase() { const directory=mkdtempSync(join(tmpdir(),"agentdock-")); return {directory,path:join(directory,"data","agentdock.db")}; }
function project(app:ReturnType<typeof createApplication>,name="alpha") { return app.projects.create({name,repoPath:`/repos/${name}`,worktreeRoot:`/worktrees/${name}`}); }

test("migrates a clean database safely and enables foreign keys",()=>{
  const fixture=temporaryDatabase(); const db=openDatabase(fixture.path); try {
    assert.equal((db.prepare("SELECT COUNT(*) count FROM schema_migrations").get() as {count:number}).count,7);
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,1);
    assert.doesNotThrow(()=>openDatabase(fixture.path).close());
  } finally { db.close(); rmSync(fixture.directory,{recursive:true,force:true}); }
});

test("creates and reads projects",()=>{
  const db=openDatabase(":memory:"); try { const app=createApplication(db); const created=project(app); assert.deepEqual(app.projects.list(),[created]); assert.equal(created.baseBranch,"main"); assert.equal(created.status,"ACTIVE"); } finally { db.close(); }
});

test("creates a task and its initial revision consistently",()=>{
  const db=openDatabase(":memory:"); try { const app=createApplication(db); const created=app.tasks.create(project(app).id,"Implement durable tasks"); const shown=app.tasks.show(created.task.id); assert.equal(shown.task.currentRevision,1); assert.equal(shown.currentRevision.request,"Implement durable tasks"); assert.equal(shown.revisions.length,1); } finally { db.close(); }
});

test("new requirements preserve earlier revisions",()=>{
  const db=openDatabase(":memory:"); try { const app=createApplication(db); const created=app.tasks.create(project(app).id,"first request"); app.tasks.revise(created.task.id,"changed request"); const shown=app.tasks.show(created.task.id); assert.equal(shown.task.currentRevision,2); assert.deepEqual(shown.revisions.map(r=>r.request),["first request","changed request"]); } finally { db.close(); }
});

test("data persists after reopening the database",()=>{
  const fixture=temporaryDatabase(); let db=openDatabase(fixture.path); const app=createApplication(db); const p=project(app); const task=app.tasks.create(p.id,"persistent request"); db.close();
  db=openDatabase(fixture.path); try { const reopened=createApplication(db); assert.equal(reopened.projects.list()[0]?.id,p.id); assert.equal(reopened.tasks.show(task.task.id).currentRevision.request,"persistent request"); } finally { db.close(); rmSync(fixture.directory,{recursive:true,force:true}); }
});

test("foreign keys and domain constraints reject invalid data",()=>{
  const db=openDatabase(":memory:"); try {
    assert.throws(()=>db.prepare("INSERT INTO tasks (id,project_id,state,current_revision,created_at,updated_at) VALUES ('t','missing','DRAFT',1,'now','now')").run(),/FOREIGN KEY/);
    const app=createApplication(db); assert.throws(()=>app.projects.create({name:"bad",repoPath:"/bad",worktreeRoot:"/bad",maxConcurrentTasks:0}),/positive/);
    assert.throws(()=>app.tasks.create(project(app).id,"   "),/request is required/);
  } finally { db.close(); }
});

test("failed initial revision rolls back the task",()=>{
  const db=openDatabase(":memory:"); try { const app=createApplication(db); const p=project(app); const task={id:"task",projectId:p.id,state:"DRAFT" as const,currentRevision:1,branch:null,worktreePath:null,createdAt:"now",updatedAt:"now"}; assert.throws(()=>app.repositories.tasks.createWithRevision(task,{id:"revision",taskId:"different",revision:1,request:"request",createdAt:"now"}),/FOREIGN KEY/); assert.equal(app.repositories.tasks.findById("task"),undefined); } finally { db.close(); }
});
