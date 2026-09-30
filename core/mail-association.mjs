const host=value=>{try{return new URL(value).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}};
export function associateMail(message,tasks,products){
 const sender=String(message.from||'').match(/(?:<|\s|^)[^\s<>@]+@([^\s<>]+)(?:>|\s|$)/)?.[1]?.toLowerCase(),content=[message.subject,message.snippet,mailText(message.payload)].join('\n').toLowerCase();
 if(!sender)return{status:'unmatched',candidates:[]};
 const matched=tasks.filter(task=>{const site=host(task.url);return site&&(sender===site||sender.endsWith('.'+site));}).filter(task=>{
  const product=products.find(p=>p.id===task.profileId),productHost=host(product?.url||product?.fields?.Url),name=String(product?.name||product?.fields?.Name||'').toLowerCase();
  return product&&(productHost&&content.includes(productHost)||name.length>=4&&content.includes(name));
 });
 const mailAt=Date.parse(message.at),unknown=matched.filter(t=>!Number.isFinite(mailAt)||!Number.isFinite(Date.parse(t.attemptBoundary)));
 const candidates=matched.filter(t=>Number.isFinite(mailAt)&&Number.isFinite(Date.parse(t.attemptBoundary))&&mailAt>=Date.parse(t.attemptBoundary));
 const identities=[...new Set(candidates.map(t=>host(t.url)+'::'+t.profileId))];
 if(unknown.length)return{status:'candidate',candidates:[...new Set([...candidates,...unknown].map(t=>host(t.url)+'::'+t.profileId))],reason:'submission_time_unknown'};
 if(identities.length!==1)return{status:identities.length?'ambiguous':'unmatched',candidates:identities};
 return{status:'associated',identity:identities[0],taskIds:candidates.map(t=>t.id),messageId:message.id,sha256:message.sha256,at:message.at,source:'gmail_readonly',review:'unknown',publication:'unknown'};
}
export function mailText(part){if(!part)return '';const own=/^text\/(plain|html)$/.test(part.mimeType||'')&&part.body?.data?Buffer.from(part.body.data,'base64url').toString('utf8').slice(0,100000):'';return[own,...(part.parts||[]).map(mailText)].join('\n');}
