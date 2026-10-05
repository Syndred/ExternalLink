// Normal web entry for the same journal and executor components. No browser-profile access.
import http from 'node:http';import{DatabaseSync}from'node:sqlite';import{readFile,writeFile}from'node:fs/promises';import{join,resolve}from'node:path';import{homedir}from'node:os';import{timingSafeEqual,randomBytes,createHmac}from'node:crypto';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor'),root=resolve(import.meta.dirname,'../..');
const db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true});
const pair=()=>{const row=db.prepare('SELECT value FROM state WHERE id=?').get('pair');return row?JSON.parse(row.value):null;};
const sign=(value,token)=>createHmac('sha256',token).update('externallink-workbench:'+value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const files=new Map([['/','executor/web/application.html'],['/application.js','executor/web/application.js'],['/comment-studio.js','executor/web/comment-studio.js'],['/application.css','executor/web/application.css'],['/activity-time.js','executor/web/activity-time.js'],['/setup.js','executor/web/setup.js'],['/timeline-core.js','core/submission-timeline.js'],
 ['/legacy','executor/web/index.html'],['/app.js','executor/web/app.js'],...['submission-journal.js','submission-journal.css','executor-panel.js','executor-panel.css','lib/submission-journal.js'].map(p=>['/extension/'+p,'extension/'+p])]);
const controls=new Set(['/appData','/taskDetails','/profile','/registerAcceptance','/prepareTask','/runTask','/status','/catalog','/preview','/start','/pause','/resume','/sync','/takeover','/continueTask','/verify','/review','/openRecoveryTask','/observeTask','/closeObservation','/archiveDeferredTabs','/workbenchDocuments','/journalProgress','/journalFlush','/workbenchPending']);
controls.add('/saveAssistantSettings');
controls.add('/clearSiteAnnotation');controls.add('/getBatchLog');
for(const route of ['/manualSkip','/manualSubmit','/stop'])controls.add(route);
for(const route of ['/getSubmissionQueue','/advanceSubmission','/removeFromSubmissionQueue'])controls.add(route);
for(const route of ['/sidepanelOpened','/sidepanelClosed','/sidepanelDetect','/sidepanelFill'])controls.add(route);
for(const route of ['/localRecoverySources','/previewLocalRecovery','/submissionJournalRecoverLocal'])controls.add(route);
for(const route of ['/libraryMutation','/previewBatch','/startBatch','/extractProfile','/generateProfile','/commentDrafts','/detectOriginalTask','/commentHistory','/mediaLibrary','/browserLibraryPages','/addBrowserPage','/cloudSyncStatus','/cloudSyncPush','/saveCommentVersion','/quickOpenLibrary','/fillCommentDraft','/exportBackup','/previewBackup','/importBackup','/startDomainAge','/startLinkMonitor','/dismissMonitorAlert','/startPublicLibrarySync'])controls.add(route);
controls.add('/resetWorkspace');controls.add('/resolveConflict');
controls.add('/mediaUpload');
controls.add('/startAcceptance');
for(const route of ['/gmailStatus','/gmailMessage','/gmailConfigure','/gmailAuthorize','/gmailSync','/gmailRefresh'])controls.add(route);
const server=http.createServer(async(req,res)=>{try{
 const host=`127.0.0.1:${server.address().port}`,origin='http://'+host,url=new URL(req.url,origin);
 if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);res.end('来源未授权');return;}
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
 if(req.method==='GET'&&files.has(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(await readFile(join(root,files.get(url.pathname))));return;}
 const config=pair();if(!config&&((req.method==='GET'&&url.pathname==='/connection')||(req.method==='POST'&&url.pathname==='/setup'))){const service=JSON.parse(await readFile(join(home,'server.json'),'utf8')),setupHeaders={Origin:origin,'Content-Type':'application/json'},body=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error('登记文件过大');body.push(chunk);}const response=await fetch(new URL(req.method==='GET'?'/setupInfo':'/setup',service.endpoint),{method:req.method,headers:setupHeaders,...(req.method==='POST'?{body:Buffer.concat(body)}:{})});const result=await response.json();if(result.ok&&result.localToken){const value=randomBytes(32).toString('hex')+'.'+(Date.now()+86400000);res.setHeader('Set-Cookie',`el_workbench=${value}.${sign(value,result.localToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);delete result.localToken;}res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return;}if(!config){res.writeHead(401);res.end(JSON.stringify({ok:false,error:'请先连接云端'}));return;}const bearer=equal(req.headers.authorization,'Bearer '+config.localToken),cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('el_workbench='))?.slice(13),session=/^([a-f0-9]{64})\.(\d{13})\.([a-f0-9]{64})$/.exec(cookie||'');
 if(!bearer&&!(session&&Number(session[2])>Date.now()&&equal(session[3],sign(session[1]+'.'+session[2],config.localToken)))){res.writeHead(401);res.end(JSON.stringify({ok:false,error:'工作台未解锁，请使用本机启动入口'}));return;}
 if(req.method==='GET'&&url.pathname==='/connection'){if(bearer){const value=randomBytes(32).toString('hex')+'.'+(Date.now()+86400000);res.setHeader('Set-Cookie',`el_workbench=${value}.${sign(value,config.localToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,endpoint:config.endpoint,workspaceId:config.workspaceId}));return;}
 let target,headers={Authorization:'Bearer '+config.localToken,'Content-Type':'application/json'};
 if(controls.has(url.pathname)||/^\/evidence\/[a-zA-Z0-9_-]+$/.test(url.pathname)){const service=JSON.parse(await readFile(join(home,'server.json'),'utf8'));target=new URL(url.pathname,service.endpoint);}
 else if(url.pathname.startsWith('/cloud/')){const route=url.pathname.slice(7);if(!/^(workspace\/(journal-documents|submission-tasks|timeline|media\/[a-zA-Z0-9._-]+|automation\/artifacts\/[a-zA-Z0-9._-]+)|profile)$/.test(route))throw Error('接口未授权');target=new URL('/v2/executor/'+route,config.endpoint);target.search=url.search;target.searchParams.set('workspace',config.workspaceId);headers.Authorization='Bearer '+config.deviceToken;}
 else{res.writeHead(404);res.end();return;}
 if(!['GET','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(['/mediaUpload','/previewBackup','/libraryMutation'].includes(url.pathname)?9:2)*1024*1024)throw Error('请求过大');chunks.push(chunk);}
 const response=await fetch(target,{method:req.method,headers,signal:AbortSignal.timeout(['/prepareTask','/registerAcceptance'].includes(url.pathname)?600000:90000),...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
 res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}});
server.listen(Number(process.env.EXTERNALLINK_WEB_PORT||19389),'127.0.0.1',async()=>{await writeFile(join(home,'workbench.json'),JSON.stringify({pid:process.pid,endpoint:`http://127.0.0.1:${server.address().port}`}));console.log('外链助手工作台已启动');});
