import {originalTimelineMutation,timelineDocumentKeys,timelineValueEqual} from '../../../core/original-timeline-mutation.mjs';
import {timelineAuditRows} from './worker-core.mjs';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export async function neonTimelineMutation(sql,workspaceId,operation,input={}){
 const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id=${workspaceId} and document_key=any(${timelineDocumentKeys}::text[])`;
 const documents=Object.fromEntries(rows.map(row=>[row.document_key,row.data])),revisions=Object.fromEntries(rows.map(row=>[row.document_key,Number(row.revision)])),change=originalTimelineMutation(documents,operation);
 const expected=Object.fromEntries(change.revisionKeys.map(key=>[key,input.revisions?input.revisions[key]:revisions[key]||0]));
 if(Object.values(expected).some(value=>!Number.isInteger(value)||value<0))fail('缺少有效关联版本号',400);
 if(input.revision!==undefined&&(revisions.submissionTimeline||0)!==input.revision)fail('外链库已由其他客户端更新，请先回读');
 const updates=Object.entries(change.updates).map(([key,data])=>({key,data,expected_revision:expected[key]}));
 const oldEvents=Object.values(documents.submissionTimeline||{}).flat();
 const audits=timelineAuditRows(documents.submissionTimeline||{},change.data).filter(row=>row.operation!=='updated'||!timelineValueEqual(oldEvents.find(event=>event.id===row.eventId),row.event)).map(row=>({event_id:row.eventId,operation:row.operation,event:row.event}));
 try{
  const result=await sql.transaction([
   sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId},0))`,
   sql`select document_key from externallink_workspace_documents where workspace_id=${workspaceId} and document_key=any(${change.revisionKeys}::text[]) order by document_key for update`,
   sql`select (case when not exists (
     select 1 from jsonb_each_text(${JSON.stringify(expected)}::jsonb) expected
     left join externallink_workspace_documents d on d.workspace_id=${workspaceId} and d.document_key=expected.key
     where coalesce(d.revision,0)!=expected.value::bigint
   ) then '1' else 'timeline_revision_conflict_'||${workspaceId} end)::integer as ok`,
   sql`with incoming as (select * from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as i(key text,data jsonb,expected_revision bigint)),
   written as (
     insert into externallink_workspace_documents(workspace_id,document_key,data,revision)
     select ${workspaceId},key,data,1 from incoming
     on conflict(workspace_id,document_key) do update set data=excluded.data,
       revision=externallink_workspace_documents.revision+case when externallink_workspace_documents.data=excluded.data then 0 else 1 end,
       updated_at=case when externallink_workspace_documents.data=excluded.data then externallink_workspace_documents.updated_at else now() end
     where externallink_workspace_documents.revision=(select expected_revision from incoming where incoming.key=excluded.document_key)
     returning document_key,revision
   ) select jsonb_object_agg(document_key,revision) as revisions,
     (case when count(*)=${updates.length} then '1' else 'timeline_revision_conflict_'||${workspaceId} end)::integer as ok from written`,
   sql`insert into externallink_timeline_revisions(workspace_id,event_id,operation,event)
     select ${workspaceId},a.event_id,a.operation,a.event from jsonb_to_recordset(${JSON.stringify(audits)}::jsonb) as a(event_id text,operation text,event jsonb)`
  ]);
  const saved=result[3][0].revisions;return{ok:true,key:change.key,event:change.event,record:change.record,revisions:saved,revision:Number(saved.submissionTimeline)};
 }catch(error){if(/timeline_revision_conflict_/.test(error.message))fail('关联资料发生并发变更，请先回读');throw error;}
}
