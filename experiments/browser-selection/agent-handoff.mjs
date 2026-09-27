import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = process.env.TRIAL_WORKDIR;
const chrome = process.env.TRIAL_AGENT_CHROME;
assert(root && path.isAbsolute(root) && chrome);
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(path.join(root, 'endpoint.json')));
const evidence = path.join(root, 'evidence', 'agent-browser');
await mkdir(evidence, { recursive: true });
const config = path.join(root, 'agent-browser.json');
await writeFile(config, '{}');
const namespace = `h-${Date.now().toString(36)}`;
const args = ['--config',config,'--namespace',namespace,'--session','a','--profile',path.join(root,'profile-agent-handoff'),'--executable-path',chrome,'--headed','--json'];
const log = async (data) => appendFile(path.join(evidence,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n');
async function command(...commandArgs){
  let output;
  try { output = await exec(path.join(moduleRoot,'node_modules/.bin/agent-browser'), [...args,...commandArgs], { timeout:15000, maxBuffer:1024*1024, env:{...process.env,AGENT_BROWSER_DEFAULT_TIMEOUT:'1200'} }); }
  catch(error){ await log({args:commandArgs,error:String(error),stdout:error.stdout}); throw error; }
  const result=JSON.parse(output.stdout); await log({args:commandArgs,result}); assert(result.success,result.error); return result.data;
}
async function refs(){const data=await command('snapshot','-i');return name=>{const matches=Object.entries(data.refs).filter(([,v])=>v.name===name);assert.equal(matches.length,1);return '@'+matches[0][0];};}
let complete=false;
try{
  const before=await fetch(`${url}/records`).then(r=>r.json());
  await command('open',url);
  let ref=await refs();
  await command('fill',ref('Product name'),'agent-browser-supervisor-synthetic');
  await command('fill',ref('Website'),'https://example.com/');
  await command('fill',ref('Description'),'Worker draft waiting for supervisor correction');
  await command('select',ref('Category'),'games');
  await command('check',ref('Confirm synthetic test'));
  await command('upload',ref('Attachment'),path.join(root,'attachment.txt'));
  try{await command('find','role','button','click','--name','Old submit label that no longer exists');throw new Error('Injected fault did not occur');}
  catch(error){assert.match(error.stdout??'',/not found|none match name|timed out|timeout/i);}
  await command('screenshot',path.join(evidence,'paused.png'));
  await log({state:'paused_for_supervisor',owner:'supervisor',namespace,url,receiptCountBefore:before.length});
  console.log(JSON.stringify({state:'paused_for_supervisor',namespace,url,chrome}));
  const deadline=Date.now()+10*60*1000;
  while(Date.now()<deadline){
    let resume;
    try{resume=JSON.parse(await readFile(path.join(root,'agent-resume.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;await delay(300);continue;}
    assert.equal(resume.action,'resume');
    ref=await refs();
    assert.equal((await command('get','value',ref('Description'))).value,'Supervisor verified draft');
    assert.equal((await command('get','value',ref('Product name'))).value,'agent-browser-supervisor-synthetic');
    assert.equal((await fetch(`${url}/records`).then(r=>r.json())).length,before.length);
    await command('screenshot',path.join(evidence,'supervisor-corrected.png'));
    await log({state:'worker_resumed',owner:'worker',correctionVerified:true});
    await command('click',ref('Submit test'));
    await command('wait','#receipt');
    const id=(await command('get','text','#receipt')).text;
    const records=await fetch(`${url}/records`).then(r=>r.json());
    assert.equal(records.length,before.length+1);
    const record=records.find(r=>r.id===id);assert(record);assert.equal(record.description,'Supervisor verified draft');assert.equal(record.product,'agent-browser-supervisor-synthetic');
    await command('screenshot',path.join(evidence,'verified-receipt.png'));
    await writeFile(path.join(evidence,'result.json'),JSON.stringify({pass:true,takeoverMethod:'native Computer Use AX setValue',receipt:record,newReceiptCount:records.length-before.length,samePage:true,limitation:'Injected selector error; daemon/CDP remained alive',namespace},null,2));
    await log({state:'verified',owner:'supervisor',receipt:record});complete=true;console.log('PASS agent-browser native takeover and resume');break;
  }
  assert(complete,'Supervisor resume deadline expired');
}finally{await command('close');}
