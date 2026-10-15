import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {attachEngine} from '../executor/src/engine.mjs';

const sandbox={URL,structuredClone};sandbox.self=sandbox;vm.createContext(sandbox);
for(const file of ['playbooks.js','automation-ledger.js'])vm.runInContext(readFileSync(new URL('../core/'+file,import.meta.url),'utf8'),sandbox);
const P=sandbox.ExtLinkPlaybooks,L=sandbox.ExtLinkAutomationLedger;

test('current scoped rejection overrides generic title, pending wording and network success',()=>{
  for(const text of ["Hmm, that didn't go through.","We're temporarily unable to accept submissions. Please try again in a minute.",
    'Your submission was not accepted.']){
    const rejected=P.classifyEvidence('Submission received. Submitted for review.',null,{submissionResponse:{text,scope:'current_submission_response',visible:true,url:'https://directory.example/submitted/'}});
    assert.equal(rejected.matched,false);assert.equal(rejected.submissionRejected,true);
    const proof=L.validateSuccessProof({source:'deterministic_submit',actionObserved:true,confirmedBy:'agent',evidence:'Submission received',
      evidenceSignals:[{type:'visible_confirmation',text:'Submission received',matched:true},...rejected.evidenceSignals],
      networkEvidence:{matched:true,status:200}});
    assert.equal(proof.ok,false);assert.equal(proof.submissionRejected,true);
  }
});

test('unrelated historical, hidden and nonsubmission errors cannot veto a valid receipt',()=>{
  for(const response of [{text:'Submission failed last year',scope:'history',visible:true},
    {text:'Unable to accept submissions',scope:'current_submission_response',visible:false},
    {text:'Failed to load logo',scope:'current_submission_response',visible:true}]){
    assert.equal(P.classifySubmissionRejection(response),null);
    assert.equal(P.classifyEvidence('Submission received. Thank you for submitting.',null,{submissionResponse:response}).matched,true);
  }
});

test('current visible pane rejection beats InfoRelay positive title; genuine Tally and ToolPilot remain receipts',async t=>{
  let external=0;
  const cases=[
    {url:'https://inforelay.ai/submitted/?error=config',html:`<title>Submission received — InfoRelay</title><main><section class="ty-hero"><div id="ty-content"><h1>Hmm, that didn't go through.</h1><div class="ty-error">We're temporarily unable to accept submissions. Please try again in a minute.</div></div></section></main>`,rejected:true},
    {url:'https://directory.example/submit',html:`<title>Submission received</title><main><h1>Submit your tool</h1><form><label>Product name<input name="productName"></label><label>Product website URL<input name="productUrl" type="url"></label><div role="alert">Your submission was not accepted.</div></form></main>`,rejected:true},
    {url:'https://toolpilot.tools/submit',html:`<title>Submission received</title><main><h1>Submission Received!</h1><p>Thank you! Our team will review your tool and get back to you within 48 hours.</p><aside><div class="error">Unable to accept submissions in 2020.</div></aside><div class="history"><div role="alert">Your submission was not accepted last year.</div></div><div class="error" hidden>Unable to accept submissions.</div></main>`,rejected:false},
    {url:'https://businessagents.io/submit',html:`<title>Submit Your Tool</title><main><h1>Submit Your Tool</h1><form style="display:none"><input name="tool_name"></form><div><h2>✓ Submitted!</h2><p>Thanks for submitting your tool. We'll review it and get back to you within a few days.</p></div></main>`,rejected:false},
    {url:'https://qwenai.site/en/submit',html:`<title>Submit an AI tool</title><main><h1>Submit an AI tool</h1><form id="en-submit-form"><div><h2>Submitted</h2><p>Thanks — your tool is in the review queue. We usually decide within 1–3 working days.</p></div></form></main>`,rejected:false},
    {url:'https://tally.so/embed/fixture',destination:'https://directory.example/submit',html:`<title>Thank you</title><main><h1>Thanks for completing this form!</h1><div role="status">Form submitted</div><aside><div role="alert">Submission failed last year</div></aside></main>`,rejected:false},
  ];
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
  t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const example=cases.find(item=>item.url===route.request().url());
    if(example)return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html>'+example.html});
    external++;return route.abort();
  });
  const page=await context.newPage();
  for(const example of cases){
    await page.goto(example.url);
    const engine=await attachEngine(context,page.mainFrame(),async()=>({ok:true}));
    try{
      const evidence=await engine.call({action:'classifySubmitEvidence',destinationUrl:example.destination||example.url});
      const snapshot=await engine.call({action:'getPageSnapshot'});
      assert.equal(evidence.matched,!example.rejected,example.url);
      if(example.rejected){
        assert.equal(evidence.submissionRejected,true);assert.equal(evidence.evidence,'');
        assert.equal(snapshot.evidenceSignals[0].type,'submission_rejection');
        assert.equal(snapshot.evidenceSignals[0].scope,'current_submission_response');
        assert.equal(L.validateSuccessProof({source:'deterministic_submit',actionObserved:true,evidence:'Submission received',evidenceSignals:snapshot.evidenceSignals}).ok,false);
      }else{
        assert.equal(evidence.submissionRejected,undefined);
        // The embedded receipt needs the explicit destination passed to this
        // classification. An unbound snapshot alone cannot prove that identity.
        const signals=evidence.evidenceSignals||[{type:'visible_confirmation',text:evidence.evidence,url:example.url,matched:evidence.matched}];
        assert.equal(L.validateSuccessProof({source:'deterministic_submit',actionObserved:true,evidence:evidence.evidence,evidenceSignals:signals}).ok,true);
      }
      t.diagnostic(JSON.stringify({url:example.url,matched:evidence.matched,rejected:evidence.submissionRejected===true,signals:snapshot.evidenceSignals.map(signal=>signal.type)}));
    }finally{await engine.detach();}
  }
  assert.equal(external,0);
});
