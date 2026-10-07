// Immutable batch scope travels with one original run (or an existing task).
// Mutable checkpoints travel with task events, under the same lease and proof.
export const batchRecoveryVersion = 1;
export const maximumLibraryBatchCombinations = 50000;
export const canonicalBatchValue = value => Array.isArray(value)?value.map(canonicalBatchValue):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalBatchValue(value[key])])):value;
export const batchJson = value => JSON.stringify(canonicalBatchValue(value));
export const batchScopeRows = batch => batch.items.map(i => ({identity:i.identity,url:i.url,profile:i.profile||batch.profileSnapshots?.[i.profileId],profileRevision:i.profileRevision,taskId:i.taskId,runId:i.runId}));
export function batchManifest(batch) {
  const keys = ['id','scope','config','configSha256','scopeSha256','createdAt','count','items','cursor','feeLimit','cloudRecoveryVersion','cloudManifestTaskId','cloudManifestInTask','libraryScope'];
  const manifest=structuredClone(Object.fromEntries(keys.filter(key => batch[key] !== undefined).map(key => [key,batch[key]])));
  if(manifest.count>500){manifest.profileSnapshots=Object.fromEntries(manifest.items.map(item=>[item.profileId,item.profile]));manifest.items=manifest.items.map(({profile,...item})=>item);}
  return manifest;
}
export function batchCheckpoint(batch) {
  const keys = ['id','scope','configSha256','scopeSha256','cloudCheckpointRevision','status','startedAt','completedAt','reason','pauseReasonCode','unattendedState','interruptedTasks','taskInterruptionReasons','cursor','pausedAt','resumedAt','stoppedAt','pausedTaskIds','resumingPausedTaskIds'];
  return structuredClone({...Object.fromEntries(keys.filter(key => batch[key] !== undefined).map(key => [key,batch[key]])),items:batch.items.map(({taskId,status,result,reason,startedAt,completedAt}) => ({taskId,status,...(result===undefined?{}:{result}),...(reason===undefined?{}:{reason}),...(startedAt===undefined?{}:{startedAt}),...(completedAt===undefined?{}:{completedAt})}))});
}
export function batchRunMetadata(batch, item) {
  if(batch.cloudRecoveryVersion !== batchRecoveryVersion) return {};
  return {workbenchBatchId:batch.id,workbenchBatchRecoveryVersion:batchRecoveryVersion,workbenchBatchScope:batch.scope,workbenchBatchConfig:structuredClone(batch.config),workbenchBatchConfigSha256:batch.configSha256,workbenchBatchScopeSha256:batch.scopeSha256,...(item.taskId===batch.cloudManifestTaskId&&!batch.cloudManifestInTask?{workbenchBatchManifest:batch.cloudManifest||batchManifest(batch)}:{})};
}
export function batchRegisteredTask(run) {
  if(run.workbenchBatchRecoveryVersion !== batchRecoveryVersion) return {};
  return {workbenchBatchId:run.workbenchBatchId,workbenchBatchRecoveryVersion:batchRecoveryVersion,workbenchBatchScope:run.workbenchBatchScope,workbenchBatchConfigSha256:run.workbenchBatchConfigSha256,workbenchBatchScopeSha256:run.workbenchBatchScopeSha256,fillOnlyRun:run.workbenchBatchConfig?.fillOnly===true};
}
export async function validateBatchRunMetadata(run, workspace, hash) {
  if(run.workbenchBatchRecoveryVersion === undefined) return;
  const fail = message => {throw Object.assign(new Error(message),{status:400});};
  if(run.workbenchBatchRecoveryVersion !== batchRecoveryVersion || !run.workbenchBatchId || typeof run.workbenchBatchScope!=='string' || run.workbenchBatchScope.split('|').at(-1)!==workspace || !run.workbenchBatchConfig || run.workbenchBatchConfigSha256!==await hash(batchJson(run.workbenchBatchConfig))) fail('原批次恢复参数或工作区无效');
  const manifest=run.workbenchBatchManifest;
  if(!manifest) return;
  if(manifest.id!==run.workbenchBatchId || manifest.scope!==run.workbenchBatchScope || manifest.configSha256!==run.workbenchBatchConfigSha256 || manifest.scopeSha256!==run.workbenchBatchScopeSha256 || batchJson(manifest.config)!==batchJson(run.workbenchBatchConfig) || !Array.isArray(manifest.items) || manifest.count!==manifest.items.length || !manifest.items.length || manifest.items.length>maximumLibraryBatchCombinations || manifest.scopeSha256!==await hash(batchJson(batchScopeRows(manifest))) || new Set(manifest.items.map(i=>i.taskId)).size!==manifest.items.length || run.tasks.some(task=>!manifest.items.some(i=>i.taskId===task.id&&i.runId===run.id&&i.profileId===run.profileId&&i.url===task.url&&i.destinationKey===task.destinationKey))) fail('原批次完整范围与注册任务不一致');
}
