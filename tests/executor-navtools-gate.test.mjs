import test from 'node:test';import assert from 'node:assert/strict';
const {classifyNavToolsGate,navToolsAdapter}=await import('../executor/src/adapters/navtools.mjs');
test('An actual uncompleted Turnstile and disabled submit require human verification',()=>assert.equal(classifyNavToolsGate({submitDisabled:true,responsePresent:false,frameUrls:['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/f/auto_timeout/normal']})?.attentionType,'human_verification'));
test('An unrelated frame, completed response or enabled submit is not invented as a CAPTCHA failure',()=>{for(const input of [{submitDisabled:true,responsePresent:false,frameUrls:['https://ads.example/']},{submitDisabled:true,responsePresent:true,frameUrls:['https://challenges.cloudflare.com/turnstile/']},{submitDisabled:false,responsePresent:false,frameUrls:['https://challenges.cloudflare.com/turnstile/']}])assert.equal(classifyNavToolsGate(input),null);});
test('A stale empty iframe label is checked against the same public target frame tree',async()=>{
 const page={url:()=> 'https://navtools.ai/submit',frames:()=>[{url:()=>''}],evaluate:async()=>false,getByRole:()=>({count:async()=>1,isEnabled:async()=>false})};
 const context={newCDPSession:async()=>({send:async()=>({frameTree:{frame:{url:page.url()},childFrames:[{frame:{url:'https://challenges.cloudflare.com/turnstile/auto_timeout'}}]}}),detach:async()=>{}})};
 assert.equal((await navToolsAdapter.gate(page,context))?.attentionType,'human_verification');
});
