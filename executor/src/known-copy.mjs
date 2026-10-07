const text=value=>typeof value==='string'||typeof value==='number'?String(value).trim():'';
const first=(profile,keys)=>keys.map(key=>text(profile?.fields?.[key])).find(Boolean)||'';
const bounded=(value,max)=>value.length<=max?value:value.slice(0,max).replace(/\s+\S*$/,'').trim();
export function profileFieldChoices(profile,keys){
 const value=keys.map(key=>profile?.fields?.[key]).find(value=>Array.isArray(value)?value.some(item=>text(item)):text(value));
 return [...new Set((Array.isArray(value)?value:String(value||'').split(/[,;\n]+/)).map(text).filter(Boolean))];
}
export function profileTagline(profile){return first(profile,['Tagline','Short description(20-30 words)','Title'])||text(profile?.valueProposition)||text(profile?.name)||text(profile?.fields?.Name);}
export function aiOfDayCopy(profile) {
  const description=first(profile,['Short Discription(100-150 words)','Long description (250-500 words)','Description'])||text(profile?.description);
  if(!description||description.length>1500)throw new Error('站点文案缺少核实资料或超过1500字符');
  const featureValue=profileFieldChoices(profile,['AIoftheday Features','Features','Key Features','Feature description']);
  const features=featureValue.length?featureValue:(profile?.sellablePoints||[]).map(text).filter(Boolean);
  return {description,tagline:bounded(profileTagline(profile),60),features:[...new Set(features)].slice(0,5).map(value=>bounded(value,160))};
}
