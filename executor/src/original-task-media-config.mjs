import {applyOriginalCloudMediaDefaults,frozenOriginalMediaDefaults} from '../../core/original-cloud-media.mjs';
import {taskMediaReferences} from '../../core/task-media-selection.mjs';
import {jsonValueEqual} from '../../core/json-value.mjs';

export function originalTaskMediaConfig(runtime,task,config){
 const run=runtime.store.get('run:'+task.runId),defaults=frozenOriginalMediaDefaults(run);
 if(!defaults||!Object.keys(defaults).length)return config;
 const pair=runtime.store.get('pair'),profile=task.profileSnapshot||run.profile;
 if(run.profileId!==task.profileId||!run.tasks?.includes(task.id)||!jsonValueEqual(profile,run.profile)||run.workspaceId&&pair?.workspaceId&&run.workspaceId!==pair.workspaceId||run.deviceId&&pair?.deviceId&&run.deviceId!==pair.deviceId)throw Error('原云端媒体默认选择与任务、资料或归属不一致');
 for(const {ref}of taskMediaReferences(profile,defaults)){const asset=run.mediaManifest?.find(asset=>asset.asset_id===ref.slice(14));if(!asset||!/^([a-f0-9]{64})$/.test(asset.sha256||''))throw Error('原云端媒体默认选择没有冻结版本证明');}
 return applyOriginalCloudMediaDefaults(config,defaults);
}
