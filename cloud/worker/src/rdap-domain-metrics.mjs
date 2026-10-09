const bootstrapUrl='https://data.iana.org/rdap/dns.json';
const headers={Accept:'application/rdap+json, application/json'};
function eventDate(events,names){return(Array.isArray(events)?events:[]).find(event=>names.includes(String(event?.eventAction||'').toLowerCase()))?.eventDate||'';}
function metric(domain,data,now){const createdAt=eventDate(data.events,['registration','registered']),expiresAt=eventDate(data.events,['expiration','expiry']),created=Date.parse(createdAt),ageDays=Number.isFinite(created)?Math.max(0,Math.floor((now-created)/86400000)):null;return{domain,status:'ok',createdAt,expiresAt,ageDays,ageMonths:ageDays===null?null:Math.floor(ageDays/30.4375)};}
export function authoritativeRdapUrls(domain,bootstrap){
 let longest=-1,urls=[];
 for(const service of Array.isArray(bootstrap?.services)?bootstrap.services:[]){if(!Array.isArray(service?.[0])||!Array.isArray(service?.[1]))continue;for(const raw of service[0]){const suffix=String(raw).toLowerCase();if(!suffix||domain!==suffix&&!domain.endsWith('.'+suffix)||suffix.length<longest)continue;if(suffix.length>longest){longest=suffix.length;urls=[];}for(const base of service[1])try{const parsed=new URL(base);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)continue;urls.push(new URL('domain/'+encodeURIComponent(domain),parsed.href.replace(/\/?$/,'/')).href);}catch{}}}
 return[...new Set(urls)];
}
// Keep the original service and result format. If its public redirector fails,
// discover the registry from IANA's RFC 9224 DNS bootstrap, shared by the batch.
export async function lookupDomainMetrics(domains,{fetchImpl=fetch,now=Date.now()}={}){
 let bootstrap;
 const registry=()=>bootstrap||=(async()=>{const response=await fetchImpl(bootstrapUrl,{headers,signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('IANA RDAP HTTP '+response.status);const data=await response.json();if(!Array.isArray(data.services))throw Error('IANA RDAP 服务目录不完整');return data;})();
 return Promise.all(domains.map(async domain=>{
  let failure='';
  const query=async url=>{const response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('RDAP HTTP '+response.status);return metric(domain,await response.json(),now);};
  try{return await query('https://rdap.org/domain/'+encodeURIComponent(domain));}catch(error){failure=error.message;}
  try{const urls=authoritativeRdapUrls(domain,await registry());if(!urls.length)throw Error('IANA 未登记该域名后缀的 HTTPS RDAP 服务');for(const url of urls){try{return await query(url);}catch(error){failure=error.message;}}}catch(error){failure+='；'+error.message;}
  return{domain,status:'unknown',message:failure};
 }));
}
