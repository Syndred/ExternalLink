import {createInterface} from 'node:readline';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {homedir} from 'node:os';import {Store} from './store.mjs';import {assistantTools,callAssistantTool} from './assistant-tools.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
async function request(route,body){
 const store=new Store(join(home,'outbox.sqlite'),{readOnly:true});const pair=store.get('pair');store.close();if(!pair?.localToken)throw Error('本机尚未配对');
 const service=JSON.parse(await readFile(join(home,'server.json'),'utf8')),endpoint=new URL(service.endpoint);if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1')throw Error('后台必须为本机服务');
 const response=await fetch(new URL('/'+route,endpoint),{method:'POST',headers:{Authorization:'Bearer '+pair.localToken,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(['prepareTask','runTask'].includes(route)?600000:90000)}),result=await response.json();if(!response.ok||result.ok===false)throw Error(result.error||'后台请求失败');return result;
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){let message;try{message=JSON.parse(line);if(message.id===undefined)continue;let result;
 if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'externallink-local-assistant',version:'1.0.0'}};
 else if(message.method==='ping')result={};
 else if(message.method==='tools/list')result={tools:assistantTools};
 else if(message.method==='tools/call'){try{const value=await callAssistantTool(message.params?.name,message.params?.arguments||{},request);result={content:[{type:'text',text:JSON.stringify(value)}]};}catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}}
 else throw Error('接口不存在');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:message?-32601:-32700,message:error.message}})+'\n');}}
