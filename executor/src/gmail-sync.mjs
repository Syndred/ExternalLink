import {createHash} from 'node:crypto';
import {googleTokenRequest,GMAIL_READONLY,beginGmailOAuth} from './gmail-oauth.mjs';
import {associateMail} from '../../core/mail-association.mjs';
import {mailText} from '../../core/mail-association.mjs';
import {currentMailAssociations} from './mail-associations.mjs';
export function parseDesktopClient(input){
 const value=typeof input==='string'?JSON.parse(input):input,client=value?.installed;
 if(!client)throw Error('需要 Google 桌面应用客户端 JSON');
 if(!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id||''))throw Error('无效 Google 客户端');
 return{client_id:client.client_id,...(client.client_secret?{client_secret:String(client.client_secret)}:{}),project_id:String(client.project_id||'')};
}
export class GmailSync{
 constructor({store,vault,fetcher=fetch}){this.store=store;this.vault=vault;this.fetcher=fetcher;this.migrateLegacy();}
 migrateLegacy(){
  const current=this.store.get('gmail')||{};
  // Freeze the original owner before any per-record writes so an interrupted migration
  // cannot assign remaining legacy records to a subsequently authorized account.
  const migration=current.legacyMigration||{emailAddress:current.emailAddress||null,complete:false};
  if(migration.complete)return;
  this.state({legacyMigration:migration});
  for(const message of this.store.values('gmailMessage:')){
   const key='gmailMessage:'+message.id,legacy=this.store.get(key);
   if(legacy&&!legacy.emailAddress&&migration.emailAddress)this.store.set(key,{...legacy,emailAddress:migration.emailAddress});
  }
  for(const association of this.store.values('gmailAssociation:')){
   const key='gmailAssociation:'+association.messageId,legacy=this.store.get(key);
   if(legacy&&!legacy.emailAddress&&migration.emailAddress)this.store.set(key,{...legacy,emailAddress:migration.emailAddress});
  }
  this.state({legacyMigration:{...migration,complete:true}});
 }
 async verifyAccount(){
  const profile=await this.get('profile');
  if(typeof profile.emailAddress!=='string'||!profile.emailAddress.includes('@'))throw Error('Gmail 返回无效邮箱身份');
  const current=this.store.get('gmail')||{},changed=current.emailAddress&&current.emailAddress!==profile.emailAddress;
  return this.state({emailAddress:profile.emailAddress,validateAccount:false,...(changed?{historyId:null,initialSync:null,associatedCount:0}:{})});
 }
 async refresh(){
  if(this.accountRefresh)return this.accountRefresh;
  const activeSync=this.syncing;
  this.accountRefresh=(async()=>{if(activeSync)await activeSync.catch(()=>{});await this.accessToken(true);await this.verifyAccount();this.state({refreshVerifiedAt:new Date().toISOString()});return this.status();})();
  try{return await this.accountRefresh;}finally{this.accountRefresh=null;}
 }
 state(patch){return this.store.set('gmail',{...this.store.get('gmail'),...patch});}
 async configure(input){const client=parseDesktopClient(input);await this.vault.write('gmail-client',client);this.state({status:'needs_authorization',configured:true,projectId:client.project_id});return this.status();}
 messages(){const email=this.store.get('gmail')?.emailAddress;return email?this.store.values('gmailMessage:').filter(message=>message.emailAddress===email):[];}
 status(){return{scope:GMAIL_READONLY,...this.store.get('gmail'),messageCount:this.messages().length};}
 messageKey(id){const email=this.store.get('gmail')?.emailAddress;return 'gmailMessage:'+(email?createHash('sha256').update(email).digest('hex').slice(0,24)+':':'')+id;}
 storedMessage(id){return this.store.get(this.messageKey(id))||this.store.get('gmailMessage:'+id);}
 message(id){if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('无效邮件身份');const message=this.storedMessage(id);if(!message)throw Error('邮件尚未同步');if(!message.emailAddress||message.emailAddress!==this.store.get('gmail')?.emailAddress)throw Error('邮件不属于当前邮箱');const {from,subject,at,sha256}=message;return{id,from,subject,at,sha256,text:mailText(message.payload).slice(0,100000),source:'gmail_readonly'};}
 async authorize(){const client=await this.vault.read('gmail-client');if(!client)throw Error('请先配置 Google 桌面客户端');this.flow?.cancel();this.flow=await beginGmailOAuth({client,vault:this.vault,fetcher:this.fetcher,onStatus:patch=>{this.state({...patch,...(patch.status==='connected'?{validateAccount:true}:{})});if(patch.status==='connected')this.sync().catch(()=>{});}});this.state({status:'authorizing'});return{ok:true,authorizationUrl:this.flow.authorizationUrl};}
 async accessToken(force=false){
  if(this.refreshing)return this.refreshing;
  const token=await this.vault.read('gmail-tokens');if(!token?.refresh_token)throw Object.assign(Error('Gmail 需要本机只读授权'),{reauthenticationRequired:true});
  if(!force&&token.expiresAt>Date.now()+60000)return token.access_token;
  this.refreshing=(async()=>{const client=await this.vault.read('gmail-client');if(!client)throw Error('Gmail 桌面客户端尚未配置');
   const renewed=await googleTokenRequest({client_id:client.client_id,...(client.client_secret?{client_secret:client.client_secret}:{}),refresh_token:token.refresh_token,grant_type:'refresh_token'},this.fetcher);
   const refreshGrantExpiresAt=renewed.refresh_token_expires_in?new Date(Date.now()+Number(renewed.refresh_token_expires_in)*1000).toISOString():token.refreshGrantExpiresAt||null;
   await this.vault.write('gmail-tokens',{...token,...renewed,refreshGrantExpiresAt,expiresAt:Date.now()+Number(renewed.expires_in||3600)*1000});this.state({lastRefreshedAt:new Date().toISOString(),refreshGrantExpiresAt});return renewed.access_token;
  })();try{return await this.refreshing;}finally{this.refreshing=null;}
 }
 async get(route,params={},retry=true){
  if(!/^(?:profile|history|messages(?:\/[a-zA-Z0-9_-]+)?)$/.test(route))throw Error('无效只读 Gmail 路径');
  const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+route);url.search=new URLSearchParams(params).toString();
  const token=await this.accessToken(),response=await this.fetcher(url.href,{method:'GET',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  if(response.status===401&&retry){await this.accessToken(true);return this.get(route,params,false);}
  if(!response.ok){let reason='';try{const error=await response.json();reason=String(error.error?.errors?.[0]?.reason||error.error?.status||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);}catch{}throw Object.assign(Error('Gmail 只读请求失败：HTTP '+response.status+(reason?' ('+reason+')':'')),{status:response.status,reason,reauthenticationRequired:response.status===401});}return response.json();
 }
 async sync(){if(this.accountRefresh)await this.accountRefresh;if(this.syncing)return this.syncing;this.syncing=this.run();try{return await this.syncing;}finally{this.syncing=null;}}
 async run(){try{
  let current=this.store.get('gmail')||{};if(current.validateAccount)current=await this.verifyAccount();
  const ids=new Set();let historyId=current.historyId,pageToken,initial=current.initialSync;
  if(historyId){try{do{const result=await this.get('history',{startHistoryId:current.historyId,historyTypes:'messageAdded',maxResults:'100',...(pageToken?{pageToken}:{})});for(const item of result.history||[])for(const added of item.messagesAdded||[])ids.add(added.message.id);historyId=result.historyId||historyId;pageToken=result.nextPageToken;}while(pageToken);}catch(error){if(error.status!==404)throw error;historyId=null;pageToken=undefined;}}
  const syncMode=historyId?'history':'initial';
  if(!historyId){if(!initial){const profile=await this.get('profile');initial={historyId:profile.historyId,after:Math.floor((current.importAfter||Date.now()-90*86400000)/1000),startedAt:new Date().toISOString()};this.state({emailAddress:profile.emailAddress,initialSync:initial});}
   const result=await this.get('messages',{q:'after:'+initial.after,maxResults:'25',includeSpamTrash:'false',...(initial.pageToken?{pageToken:initial.pageToken}:{})});for(const message of result.messages||[])ids.add(message.id);pageToken=result.nextPageToken;historyId=pageToken?undefined:initial.historyId;
  }
  for(const id of ids){if(this.storedMessage(id)?.emailAddress===this.store.get('gmail')?.emailAddress&&this.storedMessage(id))continue;const raw=await this.get('messages/'+id,{format:'full'});const headers=Object.fromEntries((raw.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
   const message={emailAddress:this.store.get('gmail')?.emailAddress,id:raw.id,threadId:raw.threadId,at:new Date(Number(raw.internalDate)).toISOString(),from:headers.from||'',subject:headers.subject||'',snippet:raw.snippet||'',payload:raw.payload,sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),importedAt:new Date().toISOString()};this.store.set(this.messageKey(id),message);
  }
  const products=Object.entries(this.store.get('applicationSnapshot')?.snapshot?.documents?.siteProfiles||{}).map(([id,p])=>({...p,id})),tasks=this.store.values('task:');
  for(const message of this.messages()){const association=associateMail(message,tasks,products);this.store.set('gmailAssociation:'+this.messageKey(message.id).slice(13),{...association,messageId:message.id,emailAddress:message.emailAddress});}
  this.state({status:'connected',lastSyncMode:syncMode,historyId,initialSync:initial&&pageToken?{...initial,pageToken}:null,error:'',lastSyncedAt:new Date().toISOString(),lastImportedCount:ids.size,associatedCount:currentMailAssociations(this.store).length});return this.status();
 }catch(error){this.state({status:error.reauthenticationRequired?'needs_authorization':'sync_error',error:error.message,lastAttemptAt:new Date().toISOString()});throw error;}}
 start(){if(this.timer)return;this.timer=setInterval(()=>{if(['connected','sync_error'].includes(this.store.get('gmail')?.status))this.sync().catch(()=>{});},60000);this.timer.unref();}
 stop(){clearInterval(this.timer);this.timer=null;this.flow?.cancel();}
}
