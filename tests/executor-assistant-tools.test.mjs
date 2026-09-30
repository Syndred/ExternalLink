import test from 'node:test';import assert from 'node:assert/strict';
import {assistantTools,callAssistantTool} from '../executor/src/assistant-tools.mjs';
test('unified tools preserve selected product and original task identity without providing global resume or credentials',async()=>{
 const calls=[],request=async(route,body)=>{calls.push({route,body});return{ok:true};};
 await callAssistantTool('externallink_prepare_task',{taskId:'original',acceptanceId:'fixed'},request);assert.deepEqual(calls,[{route:'prepareTask',body:{taskId:'original',acceptanceId:'fixed'}}]);
 await assert.rejects(callAssistantTool('externallink_run_task',{taskId:'original'},request),/acceptanceId/);
 await callAssistantTool('externallink_preview',{profileId:'second-product',urls:['https://site.example']},request);assert.equal(calls[1].body.profileId,'second-product');
 await assert.rejects(callAssistantTool('externallink_resume',{},request),/工具/);await assert.rejects(callAssistantTool('externallink_app_data',{localToken:'secret'},request),/参数/);
 assert.ok(assistantTools.some(t=>t.name==='externallink_app_data'));assert.ok(assistantTools.some(t=>t.name==='externallink_pause'));assert.doesNotMatch(JSON.stringify(assistantTools),/gmailAuthorize|gmailConfigure|localToken|deviceToken/);
});
