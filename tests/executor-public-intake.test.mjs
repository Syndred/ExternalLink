import test from 'node:test';import assert from 'node:assert/strict';
import * as runtime from '../executor/src/runtime.mjs';
test('visible challenge and login are classified even when there is no operable submission form',()=>{
 assert.equal(runtime.publicPageBlocker({text:'Verify you are human',iframeSources:['https://challenges.cloudflare.com/turnstile/a']} ).attentionType,'human_verification');
 assert.equal(runtime.publicPageBlocker({text:'Sign in',hasPassword:true}).attentionType,'login');
 assert.equal(runtime.publicPageBlocker({text:'This typeform is now closed'}).attentionType,'site_form_unavailable');
 assert.equal(runtime.publicPageBlocker({text:'The tool is free. Upgrade to premium if you like.'}),null);
 assert.equal(runtime.publicPageBlocker({url:'https://startupbase.io/submit',title:'Sign in or create your account | StartupBase',text:'Continue with Google',fieldLabels:[]}).attentionType,'login');
 assert.equal(runtime.publicPageBlocker({url:'https://resource.fyi/account/submit/',title:'Login | Resource.fyi',text:'Sign in with Google',fieldLabels:[]}).attentionType,'login');
 assert.equal(runtime.publicPageBlocker({title:'404 Not Found',text:'404 Not Found The resource requested could not be found on this server!'}).attentionType,'site_unavailable');
 assert.equal(runtime.publicPageBlocker({title:'Submit Your Startup',text:'Sign in to receive updates',fieldLabels:[{type:'url',label:'Website URL'}]}),null);
});
test('entry discovery uses only unambiguous observed public links and never a guessed URL',()=>{
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Submit a tool',href:'https://directory.example/submit'}])?.href,'https://directory.example/submit');
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Submit a tool',href:'https://unrelated.example/submit'}]),null);
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Search',href:'https://directory.example/search'}]),null);
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Submit',href:'chrome://settings'}]),null);
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Submit a tool',href:'https://directory.example/a'},{text:'Submit a tool',href:'https://directory.example/b'}]),null);
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'List Your Company',href:'https://directory.example/join'}])?.href,'https://directory.example/join');
 for(const text of ['Submit URL','Suggest a Website','Add URL','Submit Your Company','提交网站','推荐工具','添加网站'])
  assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text,href:'https://directory.example/entry'}])?.href,'https://directory.example/entry',text);
 assert.equal(runtime.chooseObservedEntry('https://directory.example/',[{text:'Submit payment',href:'https://directory.example/checkout'}]),null);
});
test('a homepage newsletter does not hide its visible submission link',()=>{
 assert.equal(runtime.hasSubmissionFields({fieldLabels:[{type:'email',label:'Email address'}]}),false);
 assert.equal(runtime.hasSubmissionFields({fieldLabels:[{type:'text',label:'Search This Website'}]}),false);
 assert.equal(runtime.hasSubmissionFields({fieldLabels:[{type:'text',label:'AI Tool Website URL'}]}),true);
});
test('a verified free card may open signup while checkout and mixed paid cards stay blocked',()=>{
 assert.equal(runtime.chooseFreeOffer('https://directory.example/pricing',[{heading:'Free',text:'Free Submission Free Submit 1 startup',textLabel:'Submit now',href:'https://directory.example/signup'}])?.href,'https://directory.example/signup');
 for(const offer of [{heading:'Free',text:'Free trial then $29 per month',href:'https://directory.example/signup'},{heading:'Free',text:'Free Submission',href:'https://checkout.stripe.com/pay'}])assert.equal(runtime.chooseFreeOffer('https://directory.example/pricing',[offer]),null);
 assert.equal(runtime.publicPageBlocker({url:'https://directory.example/signin',text:'Continue with Google',fieldLabels:[]}).attentionType,'login');
 assert.equal(runtime.publicPageBlocker({url:'https://directory.example/contact',title:'Contact Us',text:'Contact us',fieldLabels:[{label:'Your message',type:'textarea'}]}).attentionType,'email_only');
});
