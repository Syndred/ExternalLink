import { D1Store } from './d1-store.mjs';
import { STATE_DOCUMENT_KEYS, applyPatchOperations, normalizeDocuments, parseBearerToken, secureEqual, mediaObjectKey, artifactObjectKey } from './worker-core.mjs';
import '../../../core/submission-timeline.js';
import {originalTimelineMutation,timelineDocumentKeys} from '../../../core/original-timeline-mutation.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
export async function d1Api(request,env,authorised,auxiliary){
  const url=new URL(request.url),path=url.pathname.replace(/^\/v2/,'');
  const workspace=url.searchParams.get('workspace')||'default';
  if(workspace!==(env.ALLOWED_WORKSPACE_ID||'default'))return json({ok:false,error:'工作区未授权'},403);
  const recovery=path.startsWith('/recovery/');
  const supplied=parseBearerToken(request.headers.get('Authorization'))||'';
  const originalMediaAudit=path==='/recovery/original-media-catalogue';
  const allowed=recovery?(
    (!!env.D1_RECOVERY_TOKEN&&await secureEqual(supplied,env.D1_RECOVERY_TOKEN))||
    (originalMediaAudit&&!!env.ORIGINAL_MEDIA_AUDIT_TOKEN&&await secureEqual(supplied,env.ORIGINAL_MEDIA_AUDIT_TOKEN))
  ):await authorised(request,env);
  if(!allowed)return json({ok:false,error:'未授权'},401);
  if(!env.LEDGER_DB)return json({ok:false,error:'D1 尚未配置'},503);
  const store=new D1Store(env.LEDGER_DB,env.MEDIA_BUCKET,workspace);
  try{
    if(path==='/recovery/original-media-catalogue'){
      if(request.method!=='GET')return json({ok:false,error:'原媒体目录审计只支持读取'},405);
      return auxiliary?await auxiliary(path,request):json({ok:false,error:'原媒体目录读取未配置'},503);
    }
    if(path.startsWith('/ai/')||path==='/domain/metrics')return auxiliary?await auxiliary(path,request):json({ok:false,error:'AI 接口未配置'},503);
    if(path.startsWith('/executor/')||path==='/automation/events')return json({ok:false,error:'旧执行器流水尚未切换至 D1，已保留本机队列；禁止自动重投',code:'EXECUTOR_MIGRATION_PENDING'},503);
    if(request.method==='GET'&&path==='/health')return json({ok:true,workspaceId:workspace,storage:'d1+r2',revisions:await store.revisions()});
    if(request.method==='GET'&&path==='/revisions')return json({ok:true,workspaceId:workspace,revisions:await store.revisions()});
    if(request.method==='GET'&&path==='/media'){
      const prefix=`workspaces/${workspace}/media/`,listing=await env.MEDIA_BUCKET.list({prefix,limit:200,cursor:url.searchParams.get('cursor')||undefined,include:['customMetadata','httpMetadata']});
      return json({ok:true,assets:listing.objects.map(object=>({asset_id:object.key.slice(prefix.length),file_name:object.customMetadata?.fileName||object.key.slice(prefix.length),profile_id:object.customMetadata?.profileId||'',media_kind:object.customMetadata?.kind||'',content_type:object.httpMetadata?.contentType||'',byte_length:object.size,sha256:object.customMetadata?.sha256||''})),next:listing.truncated?listing.cursor:null});
    }
    if(request.method==='GET'&&path==='/snapshot'){
      const documents={},revisions=await store.revisions();
      for(const key of Object.keys(revisions)){const row=await store.document(key);documents[key]=row.data;revisions[key]=row.revision;}
      return json({ok:true,workspaceId:workspace,documents,revisions,storage:'d1+r2'});
    }
    const media=path.match(/^\/(media|automation\/artifacts)\/([a-zA-Z0-9._-]+)$/);
    if(media&&request.method==='GET'){
      const object=await env.MEDIA_BUCKET.get(media[1]==='media'?mediaObjectKey(workspace,media[2]):artifactObjectKey(workspace,media[2]));
      if(!object)return json({ok:false,error:'图片对象不存在'},404);
      const headers=new Headers();object.writeHttpMetadata(headers);headers.set('Cache-Control','private, max-age=3600');headers.set('X-Content-Type-Options','nosniff');
      if(/^image\/svg\+xml(?:;|$)/i.test(headers.get('Content-Type')||''))headers.set('Content-Security-Policy',"sandbox; script-src 'none'");
      return new Response(object.body,{headers});
    }
    if(media&&request.method==='PUT')return auxiliary?await auxiliary(path,request):json({ok:false,error:'图片上传未配置'},503);
    if(request.method==='GET'&&path==='/submission-tasks')return json(await store.journal(url.searchParams));
    if(request.method==='GET'&&path==='/journal-documents'){
      const documents={},revisions={};
      for(const key of ['siteProfiles',...timelineDocumentKeys]){const row=await store.document(key);if(row){documents[key]=row.data;revisions[key]=row.revision;}}
      // Archived-only records remain visible without becoming current successes.
      const archived=await env.LEDGER_DB.prepare("SELECT object_key,checksum FROM recovery_objects WHERE workspace=? AND id=? AND kind='source_backup'").bind(workspace,'plugin-backup-2026-09-25').first();
      if(archived){const backup=await store.readObject(archived.object_key,archived.checksum);documents.historicalRecords=Object.fromEntries(Object.entries(backup.submissionRecords||{}).filter(([key])=>!Object.hasOwn(documents.submissionRecords||{},key)).map(([key,record])=>[key,{...record,archiveSource:'2026-09-25',requiresVerification:true}]));}
      return json({ok:true,documents,revisions,storage:'d1+r2'});
    }
    if(request.method==='GET'&&path==='/recovery/status'){
      const [tasks,archives,documents]=await env.LEDGER_DB.batch([
        env.LEDGER_DB.prepare('SELECT count(*) AS total FROM journal_tasks WHERE workspace=?').bind(workspace),
        env.LEDGER_DB.prepare('SELECT kind,count(*) AS total,sum(bytes) AS bytes FROM recovery_objects WHERE workspace=? GROUP BY kind').bind(workspace),
        env.LEDGER_DB.prepare('SELECT key,revision,checksum,bytes FROM documents WHERE workspace=? ORDER BY key').bind(workspace),
      ]);
      return json({ok:true,tasks:tasks.results[0].total,archives:archives.results,documents:documents.results});
    }
    if(request.method==='GET'&&path==='/recovery/proof'){
      const task=url.searchParams.get('taskId'),id=url.searchParams.get('id');
      const row=await env.LEDGER_DB.prepare(task?'SELECT object_key,checksum FROM journal_tasks WHERE workspace=? AND id=?':'SELECT object_key,checksum FROM recovery_objects WHERE workspace=? AND id=?').bind(workspace,task||id||'').first();
      if(!row)return json({ok:false,error:'恢复记录不存在'},404);
      await store.readObject(row.object_key,row.checksum);
      return json({ok:true,id:task||id,checksum:row.checksum,verified:true});
    }
    const state=path.match(/^\/state\/([a-zA-Z0-9_-]+)$/);
    if(state&&!STATE_DOCUMENT_KEYS.includes(state[1]))return json({ok:false,error:'不支持的状态文档'},404);
    if(state&&request.method==='GET'){
      const current=await store.document(state[1]);return current?json({ok:true,documentKey:state[1],...current}):json({ok:false,error:'状态文档不存在'},404);
    }
    if(['POST','PUT','PATCH'].includes(request.method)){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>9*1024*1024)return json({ok:false,error:'请求过大'},413);
      const input=JSON.parse(raw);
      if(path==='/migrate'&&request.method==='POST'){
        const documents=normalizeDocuments(input.documents),existing=await store.revisions();
        for(const [key,data]of Object.entries(documents))if(existing[key]){
          const current=await store.document(key);if(JSON.stringify(current.data)!==JSON.stringify(data))return json({ok:false,error:'D1 已有不同资料，请使用本机资料恢复入口或先拉取',conflictKeys:[key]},409);
        }
        for(const [key,data]of Object.entries(documents))await store.putDocument(key,data,existing[key]||0);
        return json({ok:true,workspaceId:workspace,totalDocuments:Object.keys(documents).length,resumed:!!Object.keys(existing).length});
      }
      if(path==='/recover-local-document'&&request.method==='POST'){
        const documents=normalizeDocuments({[input.key]:input.data});
        if(!Object.hasOwn(documents,input.key))return json({ok:false,error:'无效资料文档'},400);
        const current=await store.document(input.key);
        if((current?.revision||0)!==input.revision)return json({ok:false,error:'云端版本已更新，请刷新后重试'},409);
        // Preserve the exact browser export before adopting it. This route never
        // copies connection credentials or acknowledges executor outbox events.
        const original=await store.object(documents[input.key]);
        await store.archive('local-'+input.key+'-'+original.checksum,'source_backup',documents[input.key]);
        let data=documents[input.key];
        if(input.key==='submissionTimeline')data=globalThis.ExtLinkSubmissionTimeline.mergeTimelines(current?.data||{},data);
        if(input.key==='submissionRecords'){
          data={...(current?.data||{})};for(const [key,record]of Object.entries(documents[input.key])){
            const previous=data[key];if(!previous||(!previous.taskId&&String(record.submittedAt||'')>=String(previous.submittedAt||''))||(record.taskId&&previous.taskId===record.taskId))data[key]={...previous,...record};
          }
        }
        return json({ok:true,documentKey:input.key,data,...await store.putDocument(input.key,data,input.revision)});
      }
      if(path==='/timeline'&&request.method==='POST'){
        const event=globalThis.ExtLinkSubmissionTimeline.normalizeEvent({...input.event,source:input.event?.source||'manual',confirmedBy:input.event?.source==='agent'?input.event.confirmedBy||'agent':'manual'});
        for(let attempt=0;attempt<3;attempt++){
          const documents={},revisions={};for(const key of timelineDocumentKeys){const row=await store.document(key);documents[key]=row?.data;revisions[key]=row?.revision||0;}
          const change=originalTimelineMutation(documents,{action:'add',event});
          try{const saved=await store.putDocuments(change.updates,revisions);return json({ok:true,event,record:change.record,revision:saved.revisions.submissionTimeline,...saved});}
          catch(error){if(error.status!==409||attempt===2)throw error;}
        }
      }
      if(path==='/recovery/task'&&request.method==='POST')return json({ok:true,...await store.importTask(input.task)});
      if(path==='/recovery/archive'&&request.method==='POST'){
        if(!/^[a-zA-Z0-9._-]{1,150}$/.test(input.id||'')||!['outbox','run','libraryPlan','source_backup','manifest'].includes(input.kind))return json({ok:false,error:'无效恢复档案'},400);
        return json({ok:true,...await store.archive(input.id,input.kind,input.data)});
      }
      if(path==='/recovery/document'&&request.method==='POST'){
        const docs=normalizeDocuments({[input.key]:input.data});
        if(!Object.hasOwn(docs,input.key))return json({ok:false,error:'无效文档'},400);
        const existing=await store.document(input.key);
        if(existing&&JSON.stringify(existing.data)!==JSON.stringify(input.data))return json({ok:false,error:'恢复不能覆盖现有资料'},409);
        return json({ok:true,...await store.putDocument(input.key,docs[input.key],existing?.revision||0)});
      }
      if(state&&['PUT','PATCH'].includes(request.method)){
        const current=await store.document(state[1]);
        const revision=request.method==='PATCH'?current?.revision||0:input.revision;
        const data=request.method==='PATCH'?applyPatchOperations(current?.data,input.operations):input.data;
        const docs=normalizeDocuments({[state[1]]:data});
        return json({ok:true,documentKey:state[1],data:docs[state[1]],...await store.putDocument(state[1],docs[state[1]],revision)});
      }
    }
    return json({ok:false,error:'D1 接口不存在'},404);
  }catch(error){return json({ok:false,error:error.message},error.status||500);}
}
