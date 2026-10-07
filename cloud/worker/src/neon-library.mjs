import {applicationMutation} from '../../../core/application-mutation.mjs';
import {applicationMutationDependencies} from '../../../core/application-mutation-dependencies.mjs';
import {neonTimelineMutation} from './neon-timeline.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const archiveSchemas=new WeakMap();
export async function installNeonRecoverySchema(sql){
 await sql`create table if not exists externallink_executor_recovery (
   workspace_id text not null references externallink_workspaces(workspace_id) on delete cascade,
   archive_id text not null, kind text not null, data jsonb not null,
   created_at timestamptz not null default now(), primary key(workspace_id,archive_id))`;
}
export async function neonLibraryMutation(sql,workspaceId,operation,input,env){
 const dependencies=applicationMutationDependencies(operation);
 if(operation.type==='timeline')return neonTimelineMutation(sql,workspaceId,operation,input);
 if(!Number.isSafeInteger(input.revision)||input.revision<0)fail('缺少有效资料版本号',400);
 const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id=${workspaceId} and document_key=any(${dependencies}::text[])`;
 const documents=Object.fromEntries(rows.map(row=>[row.document_key,row.data]));
 const revisions=Object.fromEntries(dependencies.map(key=>[key,Number(rows.find(row=>row.document_key===key)?.revision||0)]));
 const change=applicationMutation(documents,operation);
 if(!dependencies.includes(change.key)||change.updates&&(operation.type!=='automatic_mark'||Object.keys(change.updates).some(key=>!dependencies.includes(key))))fail('资料修改范围无效',403);
 if(revisions[change.key]!==input.revision)fail('外链库已由其他客户端更新，请先回读');
 if(operation.type==='automatic_mark'){
  if(!input.revisions||change.revisionKeys.some(key=>!Number.isSafeInteger(input.revisions[key])||input.revisions[key]<0)||input.revisions[change.key]!==input.revision)fail('缺少有效自动观察关联版本号',400);
  if(change.revisionKeys.some(key=>input.revisions[key]!==revisions[key]))fail('关联资料已由其他客户端更新，请先回读');
 }
 const archives=[];
 if(operation.type==='recover_local')archives.push(
  {id:'local-source-'+operation.id,data:{key:change.key,data:operation.data}},
  {id:'local-before-'+operation.id+'-'+input.revision,data:{key:change.key,revision:input.revision,data:documents[change.key]??null}}
 );
 if(operation.type==='backup_prepared_key')archives.push(
  {id:'backup-source-'+operation.id,data:{key:change.key,patch:operation.patch,profileIdMap:operation.profileIdMap||{}}},
  {id:'backup-before-'+operation.id+'-'+input.revision,data:{key:change.key,revision:input.revision,data:documents[change.key]??null}}
 );
 if(archives.length){
  if(!archiveSchemas.has(env))archiveSchemas.set(env,installNeonRecoverySchema(sql).catch(error=>{archiveSchemas.delete(env);throw error;}));
  await archiveSchemas.get(env);
 }
 const queries=[
  sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId},0))`,
  sql`select document_key from externallink_workspace_documents where workspace_id=${workspaceId} and document_key=any(${dependencies}::text[]) order by document_key for update`,
  sql`select (case when not exists (
    select 1 from jsonb_each_text(${JSON.stringify(revisions)}::jsonb) expected
    left join externallink_workspace_documents d on d.workspace_id=${workspaceId} and d.document_key=expected.key
    where coalesce(d.revision,0)!=expected.value::bigint
  ) then '1' else 'library_revision_conflict_'||${workspaceId} end)::integer as ok`
 ];
 for(const archive of archives){
  queries.push(sql`insert into externallink_executor_recovery(workspace_id,archive_id,kind,data)
    values(${workspaceId},${archive.id},'source_backup',${JSON.stringify(archive.data)}::jsonb) on conflict do nothing`);
  queries.push(sql`select (case when data=${JSON.stringify(archive.data)}::jsonb and kind='source_backup' then '1'
    else 'library_archive_conflict_'||${workspaceId} end)::integer as ok from externallink_executor_recovery
    where workspace_id=${workspaceId} and archive_id=${archive.id}`);
 }
 const updates=Object.entries(change.updates||{[change.key]:change.data});
 for(const [key,data]of updates)queries.push(sql`with written as (
   insert into externallink_workspace_documents(workspace_id,document_key,data,revision)
   values(${workspaceId},${key},${JSON.stringify(data)}::jsonb,1)
   on conflict(workspace_id,document_key) do update set data=excluded.data,
     revision=externallink_workspace_documents.revision+case when externallink_workspace_documents.data=excluded.data then 0 else 1 end,
     updated_at=case when externallink_workspace_documents.data=excluded.data then externallink_workspace_documents.updated_at else now() end
   where externallink_workspace_documents.revision=${revisions[key]}
   returning revision
 ) select max(revision) as revision,(case when count(*)=1 then '1' else 'library_revision_conflict_'||${workspaceId} end)::integer as ok from written`);
 try{
  const result=await sql.transaction(queries,{isolationLevel:'Serializable'});
  const writtenRevisions=Object.fromEntries(updates.map(([key],index)=>[key,Number(result[result.length-updates.length+index][0].revision)]));
  return{ok:true,key:change.key,revision:writtenRevisions[change.key],...(change.updates?{revisions:writtenRevisions}: {})};
 }catch(error){
  if(/library_revision_conflict_/.test(error.message)||error.code==='40001')fail('关联资料发生并发变更，请先回读');
  if(/library_archive_conflict_/.test(error.message))fail('恢复档案编号已有不同内容，原资料保留');
  throw error;
 }
}
