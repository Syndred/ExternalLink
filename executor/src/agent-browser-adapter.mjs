import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile);
const cli=fileURLToPath(new URL('../node_modules/agent-browser/bin/agent-browser.js',import.meta.url));

export class AgentBrowserAdapter {
  constructor({endpoint,targetId,taskId,browserInstance,upload}) {
    const url=new URL(endpoint);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','ws:'].includes(url.protocol))throw Error('仅连接本机专用浏览器');
    if(!/^[a-f0-9]{32}$/i.test(targetId))throw Error('缺少任务原页面身份');
    this.endpoint=endpoint;this.targetId=targetId;this.upload=upload;
    this.session='externallink-'+createHash('sha256').update(browserInstance).digest('hex').slice(0,24);
  }
  async command(args) {
    let stdout;
    try{({stdout}=await execute(process.execPath,[cli,'--session',this.session,'--cdp',this.endpoint,'--pin-tab',...args,'--json'],{timeout:30000,maxBuffer:1024*1024,windowsHide:true}));}
    catch(error){throw Error('agent-browser '+args[0]+' 失败（'+(error.killed?'timeout':typeof error.code==='number'?error.code:'process_error')+'）；原页面待重新观察');}
    const response=JSON.parse(stdout);
    if(!response.success)throw Error(response.error||'agent-browser 执行失败');
    return response.data;
  }
  async bind() {
    const {tabs}=await this.command(['tab','list']);
    const target=tabs.find(tab=>tab.targetId===this.targetId);
    if(!target||!/^https?:\/\//.test(target.url))throw Error('任务原页缺失或不是普通网页，禁止换页接管');
    await this.command(['tab',this.targetId]);
    await this.assertTarget();
  }
  async assertTarget() {
    const {tabs}=await this.command(['tab','list']);
    const target=tabs.find(tab=>tab.active);
    if(target?.targetId!==this.targetId||!/^https?:\/\//.test(target.url))throw Error('接管原页身份变化，停止操作');
  }
  async snapshot() {await this.assertTarget();return this.command(['snapshot','-i']);}
  async act(action) {
    await this.assertTarget();
    let args;
    if(action.type==='fill')args=['fill',action.selector,String(action.value||'')];
    else if(action.type==='select')args=['select',action.selector,String(action.value||'')];
    else if(action.type==='check')args=[action.checked===false?'uncheck':'check',action.selector];
    else if(action.type==='click')args=['click',action.selector];
    else if(action.type==='wait')args=['wait',String(Math.min(3000,Number(action.timeout_ms)||500))];
    else if(action.type==='upload')args=['upload',action.selector,await this.upload(action.mediaKind)];
    else throw Error('接管动作不受支持');
    return this.command(args);
  }
}
