import http from 'node:http';import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
export const GMAIL_READONLY='https://www.googleapis.com/auth/gmail.readonly';
export function gmailAuthorization(clientId,redirectUri,{state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url')}={}){
 if(!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))throw Error('需要 Google 桌面应用 OAuth 客户端 ID');
 const redirect=new URL(redirectUri);if(redirect.protocol!=='http:'||redirect.hostname!=='127.0.0.1'||!redirect.port||redirect.username||redirect.password)throw Error('授权回调必须为本机随机端口');
 const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:GMAIL_READONLY,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent'}).toString();
 return{url:url.href,state,verifier,redirectUri};
}
export async function googleTokenRequest(input,fetcher=fetch){
 const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(input),signal:AbortSignal.timeout(20000)});
 const data=await response.json();if(!response.ok||!data.access_token)throw Object.assign(Error('Google token 请求失败：'+String(data.error||response.status).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)),{reauthenticationRequired:data.error==='invalid_grant'});
 const scopes=(data.scope||GMAIL_READONLY).split(/\s+/).filter(Boolean);if(scopes.some(scope=>scope!==GMAIL_READONLY)||!scopes.includes(GMAIL_READONLY))throw Error('Google 返回了非只读 Gmail 权限；未保存令牌');return data;
}
export async function beginGmailOAuth({client,vault,onStatus,fetcher=fetch}){
 let flow,busy=false,timer;const server=http.createServer(async(req,res)=>{
  const port=server.address().port;res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(req.headers.host!=='127.0.0.1:'+port||req.method!=='GET'){res.writeHead(400);res.end('无效回调');return;}
  const url=new URL(req.url,'http://127.0.0.1:'+port),provided=Buffer.from(url.searchParams.get('state')||''),expected=Buffer.from(flow.state);
  if(url.pathname!=='/'||provided.length!==expected.length||!timingSafeEqual(provided,expected)||busy){res.writeHead(400);res.end('授权状态不匹配或回调已使用');return;}
  busy=true;
  try{if(url.searchParams.has('error'))throw Error('Google 授权未完成');const code=url.searchParams.get('code');if(!code)throw Error('Google 未返回授权码');
   const token=await googleTokenRequest({client_id:client.client_id,...(client.client_secret?{client_secret:client.client_secret}:{}),code,code_verifier:flow.verifier,redirect_uri:flow.redirectUri,grant_type:'authorization_code'},fetcher);
   if(!token.refresh_token)throw Error('Google 未返回可续期令牌；请重新授予本机离线只读权限');
   const refreshGrantExpiresAt=token.refresh_token_expires_in?new Date(Date.now()+Number(token.refresh_token_expires_in)*1000).toISOString():null;
   await vault.write('gmail-tokens',{...token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000,refreshGrantExpiresAt});
   onStatus({status:'connected',authorizedAt:new Date().toISOString(),refreshGrantExpiresAt,scope:GMAIL_READONLY});res.end('<meta charset="utf-8"><h1>Gmail 只读连接已完成</h1><p>请返回外链助手。邮件凭据仅保存在本机系统凭据库。</p>');
  }catch(error){onStatus({status:'needs_authorization',error:error.message});res.writeHead(400);res.end('<meta charset="utf-8"><h1>连接未完成</h1><p>请返回外链助手查看状态。</p>');}
  finally{clearTimeout(timer);server.close();}
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 flow=gmailAuthorization(client.client_id,'http://127.0.0.1:'+server.address().port+'/');
 timer=setTimeout(()=>{onStatus({status:'needs_authorization',error:'本次本机授权已过期，需重新开始'});server.close();},600000);timer.unref();
 return{authorizationUrl:flow.url,cancel(){clearTimeout(timer);server.close();}};
}
