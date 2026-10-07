import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {originalManualFallback,originalHumanGateAttention,originalTaskGate} from '../executor/src/original-site-classification.mjs';
import {classifyBlocker} from '../executor/src/runtime.mjs';
import {originalBatchConfig} from '../core/original-batch-config.mjs';

const baseline='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const original=path=>execFileSync('git',['show',baseline+':'+path],{encoding:'utf8',maxBuffer:4*1024*1024});
const reasons=['','CAPTCHA required','验证码与付款','OTP required','verification code required','短信码','邮箱验证码','OAuth required','第三方授权','登入','Sign-in required','Login required','Authentication required','Account required','Email verification required','One-time password required','security check','Verify you are human','Submission fee required','Unclear product pricing','Missing product fields','Accept terms','401 unauthorized','Access denied'];

test('native manual fallback and human attention follow the first pre-refactor source including precedence and explicit preferred status',()=>{
 const source=original('extension/background.js'),start=source.indexOf('function markTaskNeedsManual('),end=source.indexOf('  if (self.ExtLinkBatchControls.shouldAutoSkipGate(',start);assert.ok(start>=0&&end>start);
 const context=vm.createContext({self:{}});vm.runInContext(original('extension/lib/queue.js'),context);vm.runInContext(source.slice(start,end)+'return fallback;\n}',context);
 for(const reason of reasons)for(const preferred of ['', 'needs_manual','needs_login','needs_captcha']){
  const fallback=context.markTaskNeedsManual(null,{url:'https://original.example/submit'},null,reason,preferred);
  assert.equal(originalManualFallback(reason,preferred),fallback,reason+' / '+preferred);
  const status=context.self.ExtLinkQueue.classifyStatusFromReason(reason,fallback),attention=status==='needs_login'?'login':['needs_captcha','needs_otp'].includes(status)?'human_verification':null;
  assert.equal(originalHumanGateAttention(reason,fallback),attention,reason+' / '+preferred);
  if(!preferred&&attention)assert.equal(classifyBlocker(reason),attention,reason);
 }
 for(const reason of ['OAuth required','第三方授权','登入'])assert.equal(originalTaskGate({needs_manual:true,reason}).fallbackStatus,'needs_login');
 for(const reason of ['CAPTCHA payment required','验证码与付款'])assert.equal(originalTaskGate({needs_manual:true,reason}).fallbackStatus,'needs_captcha');
});

test('original CAPTCHA auto-skip stays disabled by the original public batch controls, including unattended and supplied true',()=>{
 const source=original('extension/sidepanel.js'),end=source.indexOf('// ExternalLink Side Panel');assert.ok(end>0);const context=vm.createContext({self:{}});vm.runInContext(source.slice(0,end),context);
 for(const options of [{},{autoSkipCaptcha:true},{unattended:true,autoSkipCaptcha:true,fillOnly:true}]){
  const expected=context.self.ExtLinkSidepanel.buildBatchConfig(options),actual=originalBatchConfig({},options);
  assert.equal(expected.autoSkipCaptcha,false);assert.equal(actual.autoSkipCaptcha,expected.autoSkipCaptcha);
 }
});
