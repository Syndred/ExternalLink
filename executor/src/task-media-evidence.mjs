import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {taskMediaReferences} from '../../core/task-media-selection.mjs';
import {frozenOriginalMediaDefaults} from '../../core/original-cloud-media.mjs';
import {jsonValueEqual} from '../../core/json-value.mjs';import {validateImageBytes} from '../../core/media-assets.mjs';
const validHash=value=>/^[a-f0-9]{64}$/.test(value||''),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Some original run manifests predate persisted R2 checksums. Their own
// approved scope already froze the exact profile and a verified local image
// before the run was registered. Read that evidence without rewriting history.
export async function originalRunMediaEvidence(runtime,runId,ref){
 const run=runtime.store.get('run:'+runId);
 if(!run?.acceptanceId||typeof ref!=='string'||!ref.startsWith('cloud-media://'))return null;
 const original=run.mediaManifest?.find(asset=>asset.asset_id===ref.slice(14));if(!original)return null;
 if(!run.profile||!taskMediaReferences(run.profile,frozenOriginalMediaDefaults(run)).some(entry=>entry.ref===ref))return null;
 if(original.sha256&&!validHash(original.sha256))throw Error('原任务素材校验值无效');
 const pair=runtime.store.get('pair');if(run.workspaceId&&pair?.workspaceId&&run.workspaceId!==pair.workspaceId)throw Error('原素材工作区不匹配');
 const frozen=runtime.store.get('acceptance:'+run.acceptanceId);if(!frozen)return null;
 if(frozen.id!==run.acceptanceId)throw Error('原素材冻结范围身份不匹配');
 const {sha256,startedAt,...scope}=frozen;
 if(!validHash(sha256)||hash(Buffer.from(JSON.stringify(scope)))!==sha256)throw Error('原素材冻结范围校验失败');
 if(!Number.isFinite(Date.parse(frozen.at))||!Number.isFinite(Date.parse(run.createdAt))||Date.parse(frozen.at)>Date.parse(run.createdAt))throw Error('原素材备份晚于任务创建，不能替换历史版本');
 const combo=frozen.combinations?.find(c=>c.profileId===run.profileId&&jsonValueEqual(c.profile,run.profile));if(!combo)return null;
 if(hash(Buffer.from(JSON.stringify(combo.profile)))!==combo.profileSha256)throw Error('原素材产品快照校验失败');
 const assets=(combo.mediaManifest||[]).filter(asset=>asset.productId===run.profileId&&asset.ref===ref&&asset.ok&&asset.file&&validHash(asset.sha256));if(!assets.length)return null;
 if(new Set(assets.map(asset=>asset.sha256)).size!==1)throw Error('原素材存在多个不同冻结版本');
 const asset=assets[0];if(validHash(original.sha256)&&original.sha256!==asset.sha256)throw Error('原素材证据与任务冻结校验不一致');
 const bytes=await readFile(asset.file);if(hash(bytes)!==asset.sha256)throw Error('原素材备份字节校验失败，禁止替换版本');validateImageBytes(bytes,asset.mime);
 return{ok:true,name:original.file_name||'image',dataUrl:'data:'+asset.mime+';base64,'+bytes.toString('base64'),sha256:asset.sha256,
  source:'original_frozen_backup',sourceScopeSha256:frozen.sha256,recoveredOriginalChecksum:!validHash(original.sha256)};
}

export async function originalTaskMediaEvidence(runtime,task,ref){
 const run=runtime.store.get('run:'+task.runId),profile=task.profileSnapshot||run?.profile;
 if(!run||run.profileId!==task.profileId||!Array.isArray(run.tasks)||!run.tasks.includes(task.id))throw Error('原素材任务与批次身份不匹配');
 if(!profile||!taskMediaReferences(profile,frozenOriginalMediaDefaults(run)).some(entry=>entry.ref===ref))throw Error('素材不属于原任务当前选定的产品资料');
 return originalRunMediaEvidence(runtime,task.runId,ref);
}
