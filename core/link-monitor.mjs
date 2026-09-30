export function checkablePublicUrl(record){for(const value of [record?.publicUrl,record?.evidenceUrl]){try{const url=new URL(value);if(/^https?:$/.test(url.protocol)&&!url.username&&!url.password)return url.href;}catch{}}return '';}
export function targetHostForProfile(profile){try{return new URL(profile?.url||profile?.promoUrl||profile?.fields?.Url||'').hostname.replace(/^www\./,'').toLowerCase();}catch{return '';}}
const decode=value=>value.replace(/&amp;/gi,'&').replace(/&#(x[0-9a-f]+|\d+);?/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&quot;/gi,'"').replace(/&apos;/gi,"'");
export function detectLinkRel(html,targetHost,baseUrl=''){
 if(!targetHost)return{found:false,rel:''};const clean=String(html||'').replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
 for(const match of clean.matchAll(/<a\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)){const tag=match[0],attributes=new Map();for(const attr of tag.slice(2,-1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)){const key=attr[1].toLowerCase();if(!attributes.has(key))attributes.set(key,attr[2]??attr[3]??attr[4]??'');}const href=attributes.get('href');if(!href)continue;let url;try{url=new URL(decode(href),baseUrl||undefined);}catch{continue;}const host=url.hostname.replace(/^www\./,'').toLowerCase();if(!/^https?:$/.test(url.protocol)||(host!==targetHost&&!host.endsWith('.'+targetHost)))continue;
  const tokens=(attributes.get('rel')||'').toLowerCase().split(/\s+/);return{found:true,rel:['nofollow','sponsored','ugc'].find(r=>tokens.includes(r))||'dofollow'};
 }return{found:false,rel:''};
}
export async function inspectPublishedLink(record,profile,fetcher=globalThis.fetch){
 const url=checkablePublicUrl(record),targetHost=targetHostForProfile(profile),checkedAt=new Date().toISOString(),base={checkedAt,url,inputUrl:url,targetHost,targetFound:false,rel:''};if(!url||!targetHost)return{...base,status:'uncheckable'};
 try{const response=await fetcher(url,{cache:'no-store',credentials:'omit',redirect:'follow',signal:AbortSignal.timeout(15000)});if(!response.ok)return{...base,status:'unreachable',httpStatus:response.status};if(!String(response.headers.get('content-type')||'').toLowerCase().includes('text/html'))return{...base,status:'uncheckable',httpStatus:response.status};
  let text='';if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;for(;;){const {done,value}=await reader.read();if(done){text+=decoder.decode();break;}bytes+=value.length;if(bytes>2_000_000){await reader.cancel();return{...base,status:'uncheckable',error:'页面超过检测范围，请人工核验'};}text+=decoder.decode(value,{stream:true});}}else{text=await response.text();if(text.length>2_000_000)return{...base,status:'uncheckable',error:'页面超过检测范围，请人工核验'};}
  const finalUrl=response.url||url,link=detectLinkRel(text,targetHost,finalUrl);return{...base,status:link.found?'live':'missing',url:finalUrl,httpStatus:response.status,targetFound:link.found,rel:link.rel};
 }catch(error){return{...base,status:'unreachable',error:['AbortError','TimeoutError'].includes(error.name)?'timeout':error.message};}
}
