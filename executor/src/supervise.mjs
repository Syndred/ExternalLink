// A scoped, one-command operator attachment, not a second scheduler.
import { readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store.mjs';
import { repo } from './shared.mjs';
const [taskId, command = 'snapshot', ...args] = process.argv.slice(2);
if (!taskId) throw new Error('用法：node src/supervise.mjs TASK_ID [snapshot|get|fill|select|check|uncheck|frame|scroll|release] [参数]');
const allowed = new Set(['snapshot','get','fill','select','check','uncheck','frame','scroll','release']);
if (!allowed.has(command)) throw new Error('监工工具只允许观察和表单修复；提交由唯一执行器处理');
const home = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
const store = new Store(path.join(home, 'outbox.sqlite'), { readOnly: true });
const pair = store.get('pair'); store.close();
const server = JSON.parse(await readFile(path.join(home,'server.json'),'utf8'));
const call = async (route, body) => {
  const response = await fetch(server.endpoint+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${pair.localToken}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
};
const namespace = `externallink-${taskId.replace(/[^a-z0-9]/gi,'').slice(0,24)}`;
const binary = path.join(repo,'executor/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const base = ['--namespace',namespace,'--session','supervisor','--no-auto-dialog','--json'];
const exec = async parameters => {
  const {stdout}=await promisify(execFile)(binary,[...base,...parameters],{windowsHide:true,timeout:55000,maxBuffer:4*1024*1024});
  const result=JSON.parse(stdout);if(!result.success)throw new Error(result.error);return result.data;
};
const stopDaemon = async () => {
  const info=await exec(['session','info']);
  if(info.active && info.pid) process.kill(info.pid,'SIGKILL');
};
if(command==='release') {
  await stopDaemon();
  console.log(JSON.stringify(await call('/continueTask',{taskId,supervisorDisconnected:true}))); process.exit();
}
const status=await call('/status');
const task=status.tasks.find(t=>t.id===taskId);if(!task)throw new Error('任务不存在');
if(task.attemptBoundary && !['snapshot','get'].includes(command))throw new Error('已有提交尝试，监工只能先观察与核验');
const result=await call('/takeover',{taskId});
const target=result.takeover;
try {
  await exec(['connect',target.endpoint]);
  const selected=await exec(['tab',target.targetId]);
  if(selected.targetId!==target.targetId || selected.url!==target.url)throw new Error('目标页身份已变化，停止操作');
  const observation=await exec([command,...args]);
  await appendFile(path.join(home,'supervisor.jsonl'),JSON.stringify({at:new Date().toISOString(),taskId,command,args,target,observation})+'\n');
  console.log(JSON.stringify({ok:true,taskId,target,observation}));
} finally {
  await stopDaemon();
  if(!(await fetch(target.endpoint+'/json/version')).ok)throw new Error('监工结束后宿主健康检查失败');
}
