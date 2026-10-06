// Formal, workspace-scoped executor API. Device credentials never inherit the
// administrator's state replacement, migration or credential-issuing powers.
import { parseBearerToken, secureEqual } from './worker-core.mjs';
import {encodeBase64,decodePngEvidence} from './executor-binary.mjs';
import '../../../core/queue.js';
import '../../../core/target-filters.js';
import '../../../core/opportunity-score.js';
import '../../../core/submission-timeline.js';
import '../../../core/library-classifier.js';
import '../../../core/executor-contract.js';

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
// PostgreSQL builds these authenticated read envelopes as JSON text. Returning
// that text avoids decoding every nested document/task and encoding it again
// in a Worker with a small CPU budget. No response data is cached or truncated.
const replyJsonText = payload => new Response(payload, {headers:{'Content-Type':'application/json'}});
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const schemaUpgrades = new WeakMap();

export async function installExecutorSchema(sql) {
  await sql`create table if not exists externallink_executor_devices (
    workspace_id text not null, device_id text not null, token_hash text not null,
    name text not null, revoked boolean not null default false, created_at timestamptz not null default now(),
    primary key(workspace_id, device_id))`;
  await sql`create table if not exists externallink_executor_runs (
    workspace_id text not null, run_id text not null, device_id text not null,
    data jsonb not null, updated_at timestamptz not null default now(), primary key(workspace_id, run_id))`;
  await sql`create table if not exists externallink_executor_tasks (
    workspace_id text not null, task_id text not null, run_id text not null, device_id text not null,
    identity text not null, version integer not null default 1, lease_until timestamptz,
    data jsonb not null, updated_at timestamptz not null default now(),
    primary key(workspace_id, task_id), unique(workspace_id, identity))`;
  await sql`create table if not exists externallink_executor_events (
    workspace_id text not null, event_id text not null, device_id text not null,
    task_id text not null, data jsonb not null, created_at timestamptz not null default now(),
    primary key(workspace_id, event_id))`;
  await sql`alter table externallink_executor_tasks add column if not exists controller_id text`;
  await sql`create table if not exists externallink_executor_enrollments (token_hash text primary key, used_at timestamptz not null default now())`;
}

export async function executorApi(request, env, sql, workspaceId, helpers) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (!path.startsWith('/v1/executor/')) return null;
  try {
    const token = parseBearerToken(request.headers.get('Authorization'));
    const admin = !!token && !!env.APP_ACCESS_TOKEN && await secureEqual(token, env.APP_ACCESS_TOKEN);
    const input = request.method === 'GET' ? {} : await request.json();
    if (path === '/v1/executor/devices' && request.method === 'POST') {
      let enrollment;
      try { enrollment = JSON.parse(env.EXECUTOR_ENROLLMENT || 'null'); } catch {}
      const enrolled = !admin && token?.startsWith('ele_') && enrollment?.workspaceId === workspaceId &&
        Number(enrollment.expiresAt) > Date.now() && await secureEqual(await digest(token), enrollment.hash || '');
      if (!admin && !enrolled) return reply({ ok: false, error: '需要已登录插件或有效的一次性设备登记凭据' }, 401);
      await installExecutorSchema(sql);
      const deviceId = crypto.randomUUID(), deviceToken = `eld_${secret()}`;
      const queries = [];
      if (enrolled) queries.push(sql`insert into externallink_executor_enrollments(token_hash) values(${enrollment.hash})`);
      queries.push(sql`insert into externallink_executor_devices(workspace_id, device_id, token_hash, name)
        values(${workspaceId}, ${deviceId}, ${await digest(deviceToken)}, ${String(input.name || 'Windows').slice(0, 100)})`);
      await sql.transaction(queries);
      return reply({ ok: true, deviceId, deviceToken, workspaceId });
    }
    if (path === '/v1/executor/revoke' && request.method === 'POST') {
      if (!admin) return reply({ ok: false, error: '未授权' }, 401);
      await sql`update externallink_executor_devices set revoked=true where workspace_id=${workspaceId} and device_id=${input.deviceId}`;
      return reply({ ok: true });
    }
    if (!token?.startsWith('eld_')) return reply({ ok: false, error: '需要正式设备凭据' }, 401);
    const devices = await sql`select device_id from externallink_executor_devices
      where workspace_id=${workspaceId} and token_hash=${await digest(token)} and revoked=false`;
    const deviceId = devices[0]?.device_id;
    if (!deviceId) return reply({ ok: false, error: '设备未授权或已撤销' }, 401);
    if (!schemaUpgrades.has(env)) schemaUpgrades.set(env, Promise.resolve(sql`alter table externallink_executor_tasks add column if not exists controller_id text`).catch(error => { schemaUpgrades.delete(env); throw error; }));
    await schemaUpgrades.get(env);
    if (path === '/v1/executor/diagnostics' && request.method === 'POST') {
      const id = crypto.randomUUID();
      const before = await sql`select document_key,revision,md5(data::text) as hash from externallink_workspace_documents where workspace_id=${workspaceId} order by document_key`;
      const payload = { id, deviceId, workspaceId, type: 'device_diagnostic', at: new Date().toISOString() };
      await sql`insert into externallink_executor_events(workspace_id,event_id,device_id,task_id,data) values(${workspaceId},${id},${deviceId},'diagnostic',${JSON.stringify(payload)}::jsonb)`;
      const rows = await sql`select data from externallink_executor_events where workspace_id=${workspaceId} and event_id=${id} and device_id=${deviceId}`;
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const key = `${workspaceId}/executor-diagnostics/${deviceId}/${id}.json`;
      await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/json' } });
      const object = await env.MEDIA_BUCKET.get(key);
      const read = await object.text();
      const after = await sql`select document_key,revision,md5(data::text) as hash from externallink_workspace_documents where workspace_id=${workspaceId} order by document_key`;
      return reply({ ok: true, diagnostic: rows[0].data, r2Readback: read === JSON.stringify(payload), businessDocumentsUnchanged: JSON.stringify(before) === JSON.stringify(after), before, after });
    }
    const readTask = async taskId => {
      const rows = await sql`select * from externallink_executor_tasks where workspace_id=${workspaceId} and task_id=${taskId} and device_id=${deviceId}`;
      if (!rows[0]) fail('任务不属于当前设备', 403);
      return rows[0];
    };
    if (path === '/v1/executor/snapshot' && request.method === 'GET') {
      const rows=await sql`select jsonb_build_object('ok',true,'deviceId',${deviceId}::text,'workspaceId',${workspaceId}::text,
        'documents',coalesce(jsonb_object_agg(document_key,data) filter(where document_key in
          ('siteProfiles','sheetTableData','urlList','siteAnnotations','submissionRecords','submissionTimeline','domainBlacklist','targetFilters','deletedSubmissionKeys')),'{}'::jsonb),
        'revisions',coalesce(jsonb_object_agg(document_key,revision),'{}'::jsonb))::text as payload
        from externallink_workspace_documents where workspace_id=${workspaceId}`;
      return replyJsonText(rows[0].payload);
    }
    if (path === '/v1/executor/profile' && request.method === 'POST') {
      const snapshot = await helpers.listSnapshot(sql, workspaceId);
      const original = snapshot.documents.siteProfiles?.[input.profileId];
      if (!original || input.profile?.id !== input.profileId) fail('资料身份不匹配', 403);
      if (input.revision !== snapshot.revisions.siteProfiles) fail('资料版本已变化，请回读后重试', 409);
      const profile = { ...original, ...input.profile, fields: { ...original.fields, ...input.profile.fields }, media: { ...original.media, ...input.profile.media }, updatedAt: new Date().toISOString() };
      const rows = await sql`update externallink_workspace_documents set data=jsonb_set(data,ARRAY[${input.profileId}],${JSON.stringify(profile)}::jsonb),revision=revision+1,updated_at=now()
        where workspace_id=${workspaceId} and document_key='siteProfiles' and revision=${input.revision} returning revision`;
      if (!rows.length) fail('资料发生并发变更',409);
      return reply({ ok: true, profile, revision: Number(rows[0].revision) });
    }
    if (path === '/v1/executor/runs' && request.method === 'GET') {
      const query = new URL(request.url).searchParams;
      const runId = query.get('runId');
      const inventory = query.get('view') === 'inventory';
      if (runId && !/^[a-zA-Z0-9-]{1,100}$/.test(runId)) fail('无效批次标识');
      if (inventory && runId) fail('轻量索引不能和单批次回读同时使用');
      if (inventory) {
        const rows=await sql`select jsonb_build_object('ok',true,
          'runs',coalesce((select jsonb_agg(jsonb_build_object('id',r.run_id,'profileId',r.data->>'profileId',
            'profileRevision',r.data->'profileRevision','createdAt',r.data->'createdAt','libraryPlanId',r.data->'libraryPlanId') order by r.updated_at desc)
            from externallink_executor_runs r where r.workspace_id=${workspaceId} and r.device_id=${deviceId}),'[]'::jsonb),
          'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.task_id,'runId',t.run_id,'url',t.data->>'url',
            'destinationKey',t.data->>'destinationKey','profileId',t.data->>'profileId','status',t.data->>'status',
            'siteStatus',t.data->>'siteStatus','attemptBoundary',t.data->'attemptBoundary','version',t.version,
            'controllerId',t.data->'controllerId') order by t.updated_at desc)
            from externallink_executor_tasks t where t.workspace_id=${workspaceId} and t.device_id=${deviceId}),'[]'::jsonb))::text as payload`;
        return replyJsonText(rows[0].payload);
      }
      if (runId) {
        const rows=await sql`select jsonb_build_object('ok',true,
          'runs',coalesce((select jsonb_agg(r.data) from externallink_executor_runs r
            where r.workspace_id=${workspaceId} and r.device_id=${deviceId} and r.run_id=${runId}),'[]'::jsonb),
          'tasks',coalesce((select jsonb_agg(t.data || jsonb_build_object('version',t.version) order by t.updated_at desc)
            from externallink_executor_tasks t where t.workspace_id=${workspaceId} and t.device_id=${deviceId} and t.run_id=${runId}),'[]'::jsonb))::text as payload`;
        return replyJsonText(rows[0].payload);
      }
      const rows=await sql`select jsonb_build_object('ok',true,
        'runs',coalesce((select jsonb_agg(r.data) from
          (select data from externallink_executor_runs where workspace_id=${workspaceId} and device_id=${deviceId} order by updated_at desc limit 30) r),'[]'::jsonb),
        'tasks',coalesce((select jsonb_agg(data || jsonb_build_object('version',version) order by updated_at desc)
          from externallink_executor_tasks where workspace_id=${workspaceId} and device_id=${deviceId}),'[]'::jsonb))::text as payload`;
      return replyJsonText(rows[0].payload);
    }
    if (path === '/v1/executor/runs' && request.method === 'POST') {
      const run = input.run;
      if (!run?.id || !Array.isArray(run.tasks) || !run.tasks.length || run.tasks.length > 500) fail('每批次需包含 1–500 个任务');
      const snapshot = await helpers.listSnapshot(sql, workspaceId);
      if (run.profileRevision !== snapshot.revisions.siteProfiles || !snapshot.documents.siteProfiles?.[run.profileId]) fail('资料已更新，请重新预览', 409);
      const preparation=run.mode==='single_page_preparation';
      if(preparation)globalThis.ExtLinkExecutorContract.validateSinglePagePreparation(snapshot,run);else{const scope = globalThis.ExtLinkExecutorContract.selectScope(snapshot, null, run.profileId, run.tasks.map(t => t.url));if (scope.exclusions.length || scope.tasks.length !== run.tasks.length) fail('当前云端范围包含重复或人工排除目标，请重新预览', 409);}
      const tasks = run.tasks.map(t => {
        const url = new URL(t.url);
        if (!['https:', 'http:'].includes(url.protocol) || !t.id || !t.destinationKey) fail('无效站点');
        const destinationKey = globalThis.ExtLinkQueue.normalizeDestinationKey(t.url);
        if (destinationKey !== t.destinationKey) fail('目标身份与网址不一致');
        const recordKey = globalThis.ExtLinkQueue.submissionRecordKey(destinationKey, run.profileId);
        if (snapshot.documents.submissionRecords?.[recordKey]?.status === 'success') fail(`已提交：${recordKey}`, 409);
        return { id: t.id, runId: run.id, url: t.url, destinationKey: t.destinationKey, profileId: run.profileId, identity: recordKey,
          status: preparation?'needs_manual':'pending',...(preparation?{attentionType:'fill_only',reason:'单页填写，尚未授权投稿'}:{}),siteStatus: 'not_submitted', reviewStatus: 'pending_review', version: 1 };
      });
      const mediaManifest = await sql`select asset_id,media_kind,media_index,sha256,file_name from externallink_media_assets where workspace_id=${workspaceId} and profile_id=${run.profileId}`;
      const savedRun = { ...run, profile: snapshot.documents.siteProfiles[run.profileId], mediaManifest, tasks: tasks.map(t => t.id), deviceId, workspaceId };
      const queries = [sql`insert into externallink_executor_runs(workspace_id, run_id, device_id, data)
        values(${workspaceId},${run.id},${deviceId},${JSON.stringify(savedRun)}::jsonb) on conflict do nothing`];
      for (const t of tasks) queries.push(sql`insert into externallink_executor_tasks(workspace_id,task_id,run_id,device_id,identity,data)
        values(${workspaceId},${t.id},${run.id},${deviceId},${t.identity},${JSON.stringify(t)}::jsonb)`);
      await sql.transaction(queries);
      return reply({ ok: true, run: savedRun, tasks });
    }
    if (path === '/v1/executor/lease' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      if (task.version !== input.version) fail('控制权版本已变化', 409);
      if (!input.controllerId) fail('缺少控制会话');
      const rows = await sql`update externallink_executor_tasks set lease_until=now()+interval '90 seconds',
        version=case when controller_id is not null and controller_id<>${input.controllerId} then version+1 else version end, controller_id=${input.controllerId}
        where workspace_id=${workspaceId} and task_id=${input.taskId} and device_id=${deviceId} and version=${input.version}
        and (controller_id is null or controller_id=${input.controllerId} or lease_until<now())
        returning version, lease_until`;
      if (!rows.length) fail('原控制会话租约仍有效，请等待停止或过期', 409);
      return reply({ ok: true, ...rows[0] });
    }
    if (path === '/v1/executor/handoff' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      if (!input.controllerId || !input.previousControllerId) fail('接管缺少控制会话');
      const rows = await sql`update externallink_executor_tasks set version=version+1,controller_id=${input.controllerId},lease_until=now()+interval '90 seconds'
        where workspace_id=${workspaceId} and task_id=${input.taskId} and device_id=${deviceId} and version=${input.version} and controller_id=${input.previousControllerId} returning version`;
      if (!rows.length) fail('接管控制权冲突', 409);
      return reply({ ok: true, version: rows[0].version });
    }
    if (path === '/v1/executor/event' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      if (!input.id || !input.state || input.state.id !== input.taskId || input.state.runId !== task.run_id || input.state.profileId !== task.data.profileId || input.state.destinationKey !== task.data.destinationKey) fail('事件范围不匹配', 403);
      // A supervisor can hand the browser back before the earlier takeover
      // event is flushed. Preserve that one audit event without restoring its
      // stale task state over the newer controller/version.
      if (Number(input.version) + 1 === Number(task.version) && input.type === 'takeover' &&
          input.state.controller === 'supervisor' && input.state.version === input.version &&
          Number(task.data.version || 1) < Number(task.version)) {
        await sql`insert into externallink_executor_events(workspace_id,event_id,device_id,task_id,data)
          values(${workspaceId},${input.id},${deviceId},${input.taskId},${JSON.stringify(input)}::jsonb) on conflict do nothing`;
        const old = await sql`select data=${JSON.stringify(input)}::jsonb as same from externallink_executor_events where workspace_id=${workspaceId} and event_id=${input.id} and device_id=${deviceId}`;
        if (!old[0]?.same) fail('接管审计事件不匹配', 409);
        await helpers.recordEvent({ runId: task.run_id, task, input, deviceId });
        return reply({ ok: true, eventId: input.id, historical: true });
      }
      if (task.version !== input.version) fail('控制权版本已变化', 409);
      if (task.controller_id && input.state?.controllerId !== task.controller_id) fail('事件来自过期控制会话', 409);
      const existing = await sql`select data=${JSON.stringify(input)}::jsonb as same, md5(data::text) as checksum from externallink_executor_events where workspace_id=${workspaceId} and event_id=${input.id} and device_id=${deviceId}`;
      if (existing.length) {
        if(!existing[0].same)fail('事件ID已存在但内容不一致',409);
        await helpers.recordEvent({ runId: task.run_id, task, input, deviceId });
        return reply({ ok: true, eventId: input.id, checksum:existing[0].checksum, duplicate: true });
      }
      const writes = await sql.transaction([
        sql`insert into externallink_executor_events(workspace_id,event_id,device_id,task_id,data)
          select ${workspaceId},${input.id},${deviceId},${input.taskId},${JSON.stringify(input)}::jsonb
          from externallink_executor_tasks where workspace_id=${workspaceId} and task_id=${input.taskId} and device_id=${deviceId} and version=${input.version}
          and (controller_id is null or controller_id=${input.state.controllerId || ''}) for update
          on conflict do nothing returning event_id`,
        sql`update externallink_executor_tasks set data=jsonb_set(${JSON.stringify(input.state)}::jsonb,'{reviewStatus}',coalesce(data->'reviewStatus','"pending_review"'::jsonb)), updated_at=now()
          where workspace_id=${workspaceId} and task_id=${input.taskId} and device_id=${deviceId} and version=${input.version}
          and exists(select 1 from externallink_executor_events where workspace_id=${workspaceId} and event_id=${input.id}) returning task_id`
      ]);
      if (!writes[0].length || !writes[1].length) fail('提交事件时控制权已变化，请先回读',409);
      await helpers.recordEvent({ runId: task.run_id, task, input, deviceId });
      const proof=await sql`select md5(data::text) as checksum from externallink_executor_events where workspace_id=${workspaceId} and event_id=${input.id} and device_id=${deviceId}`;
      return reply({ ok: true, eventId: input.id, checksum:proof[0].checksum });
    }
    const eventMatch = path.match(/^\/v1\/executor\/events\/([a-zA-Z0-9_-]+)$/);
    if (eventMatch && request.method === 'GET') {
      if(new URL(request.url).searchParams.get('proof')==='1'){
        const rows=await sql`select md5(data::text) as checksum from externallink_executor_events where workspace_id=${workspaceId} and event_id=${eventMatch[1]} and device_id=${deviceId}`;
        return reply(rows[0]?{ok:true,eventId:eventMatch[1],checksum:rows[0].checksum}:{ok:false},rows[0]?200:404);
      }
      const rows = await sql`select data from externallink_executor_events where workspace_id=${workspaceId} and event_id=${eventMatch[1]} and device_id=${deviceId}`;
      return reply(rows[0] ? { ok: true, event: rows[0].data } : { ok: false }, rows[0] ? 200 : 404);
    }
    if (path === '/v1/executor/receipt' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      const record = input.record;
      if (task.version !== input.version || !record || record.profileId !== task.data.profileId || record.destinationKey !== task.data.destinationKey || record.taskId !== task.task_id || !record.evidence || !record.actualSubmission) fail('回执范围或证据不完整', 403);
      const key = task.identity;
      // Insert only this product/destination; preserve all prior records and marks.
      const rows = await sql`update externallink_workspace_documents set
        data=jsonb_set(data, ARRAY[${key}], ${JSON.stringify(record)}::jsonb), revision=revision+1, updated_at=now()
        where workspace_id=${workspaceId} and document_key='submissionRecords' and not (data ? ${key}) returning revision`;
      const current = await sql`select data -> ${key} as record, revision from externallink_workspace_documents where workspace_id=${workspaceId} and document_key='submissionRecords'`;
      if (!current[0]?.record || current[0].record.taskId !== input.taskId) fail('已有记录受保护，请审阅冲突', 409);
      const timelineEvent = globalThis.ExtLinkSubmissionTimeline.normalizeEvent({ id: `executor-${input.taskId}`, destinationKey: task.data.destinationKey,
        destinationUrl: task.data.url, profileId: task.data.profileId, type: record.publicationStatus || 'submitted', status: record.publicationStatus || 'submitted',
        occurredAt: record.submittedAt, note: record.evidence, evidenceUrl: record.evidenceUrl, source: 'agent', recordKey: key });
      await sql`update externallink_workspace_documents set data=jsonb_set(data,ARRAY[${key}],coalesce(data->${key},'[]'::jsonb)||${JSON.stringify([timelineEvent])}::jsonb),revision=revision+1,updated_at=now()
        where workspace_id=${workspaceId} and document_key='submissionTimeline'
        and not exists(select 1 from jsonb_array_elements(coalesce(data->${key},'[]'::jsonb)) e where e->>'id'=${timelineEvent.id})`;
      return reply({ ok: true, record: current[0].record, revision: Number(current[0].revision), inserted: !!rows.length });
    }
    if (path === '/v1/executor/receipt-status' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      if (input.status !== 'pending_moderation' || !input.expectedEvidence) fail('只能依据原收件证据补记等待审核');
      const rows = await sql`update externallink_workspace_documents set
        data=jsonb_set(data,ARRAY[${task.identity},'publicationStatus'],${JSON.stringify('pending_moderation')}::jsonb),
        revision=revision+1,updated_at=now()
        where workspace_id=${workspaceId} and document_key='submissionRecords'
        and data->${task.identity}->>'taskId'=${input.taskId}
        and data->${task.identity}->>'evidence'=${input.expectedEvidence}
        and data->${task.identity}->>'publicationStatus'='submitted'
        returning data->${task.identity} as record,revision`;
      if (!rows.length) {
        const current = await sql`select data->${task.identity} as record,revision from externallink_workspace_documents
          where workspace_id=${workspaceId} and document_key='submissionRecords'`;
        if (current[0]?.record?.taskId !== input.taskId || current[0]?.record?.evidence !== input.expectedEvidence ||
            current[0]?.record?.publicationStatus !== 'pending_moderation') fail('原收件记录不匹配，拒绝更改', 409);
        return reply({ ok: true, record: current[0].record, revision: Number(current[0].revision), duplicate: true });
      }
      const event = globalThis.ExtLinkSubmissionTimeline.normalizeEvent({ id: `executor-${input.taskId}-pending`,
        destinationKey: task.data.destinationKey, destinationUrl: task.data.url, profileId: task.data.profileId,
        type: 'pending_moderation', status: 'pending_moderation', occurredAt: new Date().toISOString(),
        note: input.expectedEvidence, source: 'agent', recordKey: task.identity });
      await sql`update externallink_workspace_documents set data=jsonb_set(data,ARRAY[${task.identity}],
        coalesce(data->${task.identity},'[]'::jsonb)||${JSON.stringify([event])}::jsonb),revision=revision+1,updated_at=now()
        where workspace_id=${workspaceId} and document_key='submissionTimeline'
        and not exists(select 1 from jsonb_array_elements(coalesce(data->${task.identity},'[]'::jsonb)) e where e->>'id'=${event.id})`;
      return reply({ ok: true, record: rows[0].record, revision: Number(rows[0].revision) });
    }
    if (path === '/v1/executor/media' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      const assetId = String(input.ref || '').replace(/^cloud-media:\/\//, '');
      const assets = await sql`select object_key,file_name,content_type,sha256 from externallink_media_assets where workspace_id=${workspaceId} and asset_id=${assetId} and profile_id=${task.data.profileId}`;
      if (!assets[0]) fail('素材不属于当前任务产品', 403);
      const runs = await sql`select data from externallink_executor_runs where workspace_id=${workspaceId} and run_id=${task.run_id} and device_id=${deviceId}`;
      const frozen = runs[0]?.data?.mediaManifest?.find(asset => asset.asset_id === assetId);
      if (!frozen || frozen.sha256 !== assets[0].sha256) fail('素材版本已变化，请审阅后重新安排任务', 409);
      const object = await env.MEDIA_BUCKET.get(assets[0].object_key);
      if (!object) fail('素材不存在', 404);
      const bytes = new Uint8Array(await object.arrayBuffer());
      return reply({ ok: true, name: assets[0].file_name, dataUrl: `data:${assets[0].content_type};base64,${encodeBase64(bytes)}` });
    }
    if (path === '/v1/executor/artifact' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      const bytes = decodePngEvidence(input.dataUrl);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
      const id = `executor-${task.task_id}-${hash.slice(0,16)}`;
      const key = helpers.artifactObjectKey(workspaceId, id);
      await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' }, customMetadata: { taskId: task.task_id, sha256: hash } });
      const read = await env.MEDIA_BUCKET.get(key);
      const readHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await read.arrayBuffer()))].map(x => x.toString(16).padStart(2,'0')).join('');
      if (hash !== readHash) fail('证据回读不一致', 409);
      return reply({ ok: true, ref: `cloud-artifact://${id}`, sha256: hash });
    }
    if (path === '/v1/executor/artifact-read' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      const id=String(input.ref || '').replace(/^cloud-artifact:\/\//,'');
      if (!id.startsWith(`executor-${task.task_id}-`) || !/^[a-zA-Z0-9-]+$/.test(id)) fail('证据不属于该任务',403);
      const object=await env.MEDIA_BUCKET.get(helpers.artifactObjectKey(workspaceId,id));
      if(!object)fail('证据不存在',404);
      const bytes=new Uint8Array(await object.arrayBuffer());
      return reply({ok:true,dataUrl:`data:image/png;base64,${encodeBase64(bytes)}`});
    }
    if (path === '/v1/executor/plan' && request.method === 'POST') {
      await readTask(input.taskId);
      return reply({ ok: true, ...await helpers.plan(input) });
    }
    if (path === '/v1/executor/review' && request.method === 'POST') {
      const task = await readTask(input.taskId);
      if (!['reviewed', 'disputed', 'pending_review'].includes(input.reviewStatus)) fail('无效审阅状态');
      await sql`update externallink_executor_tasks set data=jsonb_set(data,'{reviewStatus}',${JSON.stringify(input.reviewStatus)}::jsonb)
        where workspace_id=${workspaceId} and task_id=${input.taskId} and device_id=${deviceId}`;
      await sql`update externallink_workspace_documents set data=jsonb_set(data,ARRAY[${task.identity},'reviewStatus'],${JSON.stringify(input.reviewStatus)}::jsonb),revision=revision+1
        where workspace_id=${workspaceId} and document_key='submissionRecords' and data->${task.identity}->>'taskId'=${input.taskId}`;
      return reply({ ok: true, task: (await readTask(input.taskId)).data });
    }
    return reply({ ok: false, error: '执行器接口不存在' }, 404);
  } catch (error) { return reply({ ok: false, error: error.message }, error.status || (error.code === '23505' ? 409 : 500)); }
}
