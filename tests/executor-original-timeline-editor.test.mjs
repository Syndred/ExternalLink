import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {originalTimelineEditor,originalTimelineSaveOutcome} from './helpers/original-timeline-editor.mjs';

test('frozen original timeline editor defaults and blank date fallback execute independently',()=>{
 const before=Date.now(),original=originalTimelineEditor(null,{occurredAt:''});
 assert.equal(original.values.profile,'__destination__');assert.equal(original.values.type,'submitted');assert.equal(original.values.note,'');assert.equal(original.cancelHidden,true);assert.ok(Date.parse(original.payload.occurredAt)>=before&&Date.parse(original.payload.occurredAt)<=Date.now());
});
test('frozen original save and cancel handlers clear only the submitted editor revision',async()=>{
 const saved=await originalTimelineSaveOutcome('saved');assert.equal(saved.editingEventId,'');assert.equal(saved.dirty,false);assert.equal(saved.calls.at(-1),'render');assert.equal(saved.disabled,false);
 const changed=await originalTimelineSaveOutcome('changed');assert.equal(changed.editingEventId,'old-event');assert.equal(changed.dirty,true);assert.equal(changed.note,'继续输入');assert.equal(changed.calls[0].note,'已提交草稿');
 const failed=await originalTimelineSaveOutcome('failed');assert.equal(failed.editingEventId,'old-event');assert.equal(failed.dirty,true);assert.equal(failed.note,'已提交草稿');assert.equal(failed.calls.length,1);assert.deepEqual(failed.alerts,['Fixture failed']);
 const cancelled=await originalTimelineSaveOutcome('cancel');assert.equal(cancelled.editingEventId,'');assert.equal(cancelled.dirty,false);assert.equal(cancelled.note,'');assert.equal(cancelled.calls.length,0);
});
test('actual timeline editor retains original reset, blank time, cancellation and pending draft behavior',{timeout:60000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-timeline-editor.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:55000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','blankTimeMatchesOriginal','successfulSaveResetsOriginalDefaults','inFlightDraftKept','failedSaveRetainsDraft','cancelWithoutWrite','lateSaveKeepsNewEditor','offlineSavedOnce','refreshFailureDoesNotRepeatSavedEvent'])assert.equal(proof[key],true);assert.equal(proof.realSubmissions,0);
});
