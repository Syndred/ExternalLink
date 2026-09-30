import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {automationSummary} from '../cloud/worker/src/submission-journal.mjs';
test('automation mirror retains status and source task identity without duplicating large evidence',()=>{
 const source={id:'t',url:'https://example.test',profileId:'A',status:'needs_manual',reason:'Login',actualSubmission:{fields:['x'.repeat(10000)]},authenticationHistory:['x'.repeat(10000)]};
 const brief=automationSummary(source);assert.equal(brief.id,'t');assert.equal(brief.reason,'Login');assert.equal(brief.actualSubmission,undefined);assert.equal(source.actualSubmission.fields[0].length,10000);
});
test('workspace journal includes different execution devices, excludes other workspaces and paginates summaries without large task evidence',async()=>{
 const module=await import('../cloud/worker/src/submission-journal.mjs').catch(()=>({}));assert.equal(typeof module.readJournal,'function','workspace journal API is required');
 const db=new PGlite();await db.exec('create table externallink_executor_tasks(workspace_id text,task_id text,device_id text,updated_at timestamptz default now(),data jsonb)');
 const sql=(strings,...params)=>db.query(strings.reduce((s,p,i)=>s+p+(i<params.length?'$'+(i+1):''),''),params).then(r=>r.rows);
 for(const [id,device,workspace] of [['a','one','w'],['b','two','w'],['c','two','other']])await sql`insert into externallink_executor_tasks values(${workspace},${id},${device},now(),${JSON.stringify({id,profileId:'A',url:'https://example.com/'+id,siteStatus:'not_submitted',status:'needs_manual',reason:'Login',actualSubmission:{fields:[{value:'X'.repeat(20000)}]}})}::jsonb)`;
 const first=await module.readJournal(sql,'w',new URLSearchParams('limit=1'));assert.equal(first.tasks.length,1);assert.equal(first.tasks[0].id,'a');assert.equal(first.next,'a');assert.equal(JSON.stringify(first).includes('actualSubmission'),false);
 const second=await module.readJournal(sql,'w',new URLSearchParams('after=a&limit=1'));assert.equal(second.tasks[0].id,'b');assert.equal(second.next,null);
 const detail=await module.readJournal(sql,'w',new URLSearchParams('taskId=b'));assert.equal(detail.task.actualSubmission.fields[0].value.length,20000);
 assert.equal((await module.readJournal(sql,'w',new URLSearchParams('taskId=c'))).task,null);await db.close();
});
