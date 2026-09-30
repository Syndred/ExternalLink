import test from 'node:test';import assert from 'node:assert/strict';import {gmailAuthorization,googleTokenRequest,GMAIL_READONLY,beginGmailOAuth} from '../executor/src/gmail-oauth.mjs';
test('desktop authorization requests exactly Gmail read-only with random state, PKCE and loopback callback',()=>{
 const a=gmailAuthorization('test.apps.googleusercontent.com','http://127.0.0.1:12345/'),b=gmailAuthorization('test.apps.googleusercontent.com','http://127.0.0.1:12345/');const url=new URL(a.url);
 assert.equal(url.searchParams.get('scope'),GMAIL_READONLY);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.notEqual(a.state,b.state);assert.notEqual(a.verifier,b.verifier);assert.throws(()=>gmailAuthorization('test.apps.googleusercontent.com','https://remote.example/callback'),/本机/);
});
test('OAuth callback refuses forged state and consumes a valid authorization only once without exposing tokens',async()=>{
 let writes=0,tokenBody;const flow=await beginGmailOAuth({client:{client_id:'test.apps.googleusercontent.com'},vault:{async write(name,tokens){writes++;assert.equal(name,'gmail-tokens');assert.equal(tokens.refresh_token,'synthetic-refresh');}},onStatus(){},fetcher:async(url,options)=>{tokenBody=new URLSearchParams(options.body);return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',scope:GMAIL_READONLY,expires_in:3600});}});
 const auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri'));callback.search='state=forged&code=synthetic-code';assert.equal((await fetch(callback)).status,400);assert.equal(writes,0);
 callback.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'synthetic-code'}).toString();const response=await fetch(callback);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/synthetic-(?:access|refresh)/);assert.equal(writes,1);assert.ok(tokenBody.get('code_verifier'));flow.cancel();
});
test('extra OAuth scopes are refused and revoked refresh grants require reauthorization',async()=>{
 await assert.rejects(googleTokenRequest({},async()=>Response.json({access_token:'fixture',scope:GMAIL_READONLY+' https://www.googleapis.com/auth/gmail.modify'})),/非只读/);
 await assert.rejects(googleTokenRequest({},async()=>Response.json({error:'invalid_grant'},{status:400})),error=>error.reauthenticationRequired===true);
});
