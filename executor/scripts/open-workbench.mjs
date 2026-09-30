import{DatabaseSync}from'node:sqlite';import{join,resolve}from'node:path';import{homedir}from'node:os';import{openSync,unlinkSync}from'node:fs';import{spawn}from'node:child_process';import{createServer,createConnection}from'node:net';
import{browserLaunch,watchdogAddress}from'../src/workbench-platform.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor'),root=resolve(import.meta.dirname,'..');
const db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true}),row=db.prepare('SELECT value FROM state WHERE id=?').get('pair');db.close();if(!row)throw Error('本机尚未配对，请先完成设备配对');const pair=JSON.parse(row.value);
async function ensureServices(){for(const[port,file,name]of [[19388,'server.mjs','d1-server'],[19389,'workbench-server.mjs','workbench']]){
 let alive=false;try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)});alive=true;}catch{}
 if(!alive){const child=spawn(process.execPath,[join(root,'src',file)],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',openSync(join(home,name+'.log'),'a'),openSync(join(home,name+'-error.log'),'a')]});child.unref();let ready=false;for(let i=0;i<30;i++){try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}if(!ready)throw Error('服务启动未完成，请查看 '+name+'-error.log');}
}}
if(process.argv.includes('--watch')){const address=watchdogAddress(process.platform,home),guard=createServer(socket=>socket.end());
 // A crashed process can leave a Unix socket. Remove it only after a refused connection.
 if(process.platform!=='win32'){await new Promise((resolve,reject)=>{const probe=createConnection(address);probe.once('connect',()=>{probe.destroy();process.exit(0);});probe.once('error',error=>{if(error.code==='ECONNREFUSED'){try{unlinkSync(address);}catch(e){if(e.code!=='ENOENT'){reject(e);return;}}resolve();}else if(error.code==='ENOENT')resolve();else reject(error);});});}
 try{await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(address,resolve);});}catch(error){if(error.code==='EADDRINUSE')process.exit(0);throw error;}await ensureServices();await import('node:fs/promises').then(fs=>fs.writeFile(join(home,'watchdog.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),services:[19388,19389]})));for(;;){await new Promise(r=>setTimeout(r,15000));try{await ensureServices();}catch(error){console.error(new Date().toISOString()+': '+error.message);}}}
await ensureServices();
if(process.argv.includes('--services-only')){console.log('外链助手后台服务已就绪');process.exit(0);}
const browser=browserLaunch(process.platform,`http://127.0.0.1:19389/#access=${encodeURIComponent(pair.localToken)}`);
const child=spawn(browser.command,browser.args,{detached:true,stdio:'ignore',windowsHide:false});child.on('error',()=>{console.error('浏览器启动失败，请检查 Chrome 是否已安装');process.exitCode=1;});child.unref();console.log('已请求打开外链助手工作台');
