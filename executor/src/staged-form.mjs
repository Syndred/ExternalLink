export function toolScoutFinalPreparation(task,body,submitDisabled){
 if(!submitDisabled||!/STEP 5 OF 5/.test(body)||!/5\s*\/\s*5 visited/.test(body)||!/human check/i.test(body))return null;
 const first=task.stageHistory?.findLast(s=>s.stage===1),details=task.stageHistory?.findLast(s=>s.stage===4)?.fields;
 const fields=first?.fields?.filter(f=>['name','url','description'].includes(f.name));
 const profile=task.profileSnapshot;
 if(fields?.length!==3||fields.find(f=>f.name==='name')?.value!==profile?.name||fields.find(f=>f.name==='url')?.value!==profile?.url||
  fields.find(f=>f.name==='description')?.value!==profile?.fields?.['Short description(20-30 words)']||details?.platform!=='Website'||details.pricing!=='Free')return null;
 return{attentionType:'human_verification',reason:'ToolScout 当前原页已恢复至免费流程最后一步，5/5社区访问已逐页登记、回读并关闭；资料齐全，真人验证仍未完成，Submit for review禁用，保留原页，未点击最终投稿',
  actualSubmission:{fields:[...fields.map(f=>({name:f.name,label:f.name==='name'?'Tool Name':f.name==='url'?'Tool URL':'Short description',type:f.name==='url'?'url':'text',value:f.value,issues:[]})),
   {label:'Platform',value:details.platform,type:'choice',issues:[]},{label:'Pricing',value:details.pricing,type:'choice',issues:[]}],issues:[],invalidCount:0,allValid:true,attachments:[]},
  validation:{emptyCount:0,invalidCount:0,totalCount:5,submitDisabled:true,allValid:false,issues:['资料齐全，等待站方真人验证'],validationFailed:true}};
}
