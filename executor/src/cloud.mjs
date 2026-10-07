import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
const flushOperations=new WeakMap();

export class Cloud {
  constructor(config, {onNetworkFailure, onSuccess} = {}) { this.config = config; this.onNetworkFailure = onNetworkFailure; this.onSuccess = onSuccess; }
  async request(route, body, method = body ? 'POST' : 'GET') {
    if(method==='POST'&&['library','profile'].includes(route)&&body){
      const bytes=Buffer.from(JSON.stringify(body));
      if(bytes.length>1024*1024)return this.transferLibrary(route,bytes);
    }
    const base = new URL(this.config.endpoint);
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('云端必须使用 HTTPS');
    const url = new URL((this.config.storageBackend==='d1'?'/v2/executor/':'/v1/executor/') + route, base);
    url.searchParams.set('workspace', this.config.workspaceId);
    let response;
    for(let attempt=0;attempt<3;attempt++){
      try{response = await fetch(url, { method, signal: AbortSignal.timeout(route.startsWith('ai/')?90000:route==='plan'&&body?.mode==='prepare_takeover'?60000:20000), headers: { Authorization: `Bearer ${this.config.deviceToken}`, 'Content-Type': 'application/json','X-Executor-Protocol':'2' }, body: body ? JSON.stringify(body) : undefined });}
      catch(error){const code=error.name==='TimeoutError'?'TIMEOUT':error.cause?.code||error.code||error.name;
        if(method==='GET'&&['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(code)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));continue;}
        const failure=Object.assign(new Error(`云端连接失败 (${code})`),{cloudNetwork:true,cloudFailure:true,status:502,code});
        this.onNetworkFailure?.(failure);
        throw failure;
      }
      if(method!=='GET'||![502,503,504].includes(response.status)||attempt===2)break;
      await response.body?.cancel();
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
    let data;
    try { data = await response.json(); }
    catch { throw Object.assign(new Error(`云端 HTTP ${response.status} 返回非 JSON 响应 (${String(response.headers.get('content-type') || 'unknown').slice(0,100)})`),{status:response.status,cloudFailure:true}); }
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `云端 HTTP ${response.status}`), {
      status: response.status,
      cloudFailure: true,
      cloudQuota: /Your account or project has exceeded the quota/i.test(String(data.error||'')),
    });
    if(method==='GET'&&/^runs(?:\?|$)/.test(route)&&!new URLSearchParams(route.split('?')[1]||'').has('after')&&data.next){
      const seen=new Set();let next=data.next;
      while(next){if(seen.has(next))throw new Error('云端批次分页游标重复');seen.add(next);
        const query=new URLSearchParams(route.split('?')[1]||'');query.set('after',next);
        const page=await this.request('runs?'+query.toString());data.runs.push(...page.runs);data.tasks.push(...page.tasks);next=page.next;
      }data.next=null;
    }
    this.onSuccess?.();
    return data;
  }
  async transferLibrary(route,bytes){
    const identityOf=config=>JSON.stringify([config.endpoint,config.workspaceId,config.deviceId||'',config.storageBackend==='d1'?'d1':'neon',config.deviceToken]);
    const identity=identityOf(this.config),check=()=>{if(identity!==identityOf(this.config))throw Error('工作区、设备或后端已切换，原备份传输保留');};
    const id=createHash('sha256').update(bytes).digest('hex'),parts=[];
    for(let offset=0;offset<bytes.length;offset+=512*1024){const part=bytes.subarray(offset,Math.min(offset+512*1024,bytes.length));parts.push({sha256:createHash('sha256').update(part).digest('hex'),bytes:part.length});}
    check();const status=await this.request('library-transfer/start',{id,route,bytes:bytes.length,parts});check();
    const present=new Set(status.present||[]);
    for(let index=0;index<parts.length;index++){if(present.has(index))continue;check();const part=bytes.subarray(index*512*1024,index*512*1024+parts[index].bytes);await this.request('library-transfer/part',{id,index,data:part.toString('base64')});check();}
    check();return this.request('library-transfer/commit',{id});
  }
  flush(store) {
    const previous=flushOperations.get(store)||Promise.resolve(),operation=previous.catch(()=>{}).then(()=>this.flushNow(store));flushOperations.set(store,operation);
    return operation.finally(()=>{if(flushOperations.get(store)===operation)flushOperations.delete(store);});
  }
  async flushNow(store) {
    for (const event of store.pendingBatch ? store.pendingBatch(100) : store.pending()) {
      if(store.get?.(`task:${event.taskId}`)?.syncConflict)continue;
      let writeError, written;
      try { written = await this.request('event', event); } catch (error) { if(error.cloudQuota)throw error;writeError=error; }
      // A gateway can lose the reply after the immutable event was stored.
      // Only an exact independent readback permits acknowledgement.
      const compact = written?.eventId === event.id && !!written?.checksum;
      const read = await this.request(`events/${event.id}${compact?'?proof=1':''}`).catch(error=>{throw writeError||error;});
      if (compact ? read.eventId !== event.id || read.checksum !== written.checksum || read.checksum !== createHash('sha256').update(JSON.stringify(event)).digest('hex') : !isDeepStrictEqual(read.event, event)) throw new Error(`云端事件回读不一致：${event.id}`);
      store.ack(event.id);
    }
  }
}
