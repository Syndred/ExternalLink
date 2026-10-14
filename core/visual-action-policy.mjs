const finalControl=/\b(submit|publish|launch|create draft|send listing|add (?:my )?(?:site|product|startup)|post comment)\b|提交|发布|创建草稿|发布评论|添加网站|添加产品/i;
const snapshotTargets=snapshot=>['fields','buttons','widgets'].flatMap(key=>Array.isArray(snapshot?.[key])?snapshot[key]:[]);

// A DOM-visible field can still be below the screenshot. Keep its identity for
// planning, but require observation after scrolling before acting on it.
export function visualPlanningSnapshot(snapshot={},elements=[]){
 const selectors=new Set(elements.map(element=>element?.selector).filter(Boolean));
 const result={...snapshot};
 for(const key of ['fields','buttons','widgets'])if(Array.isArray(snapshot[key]))result[key]=snapshot[key].map(target=>({...target,visibleInScreenshot:selectors.has(target.selector),...(!selectors.has(target.selector)?{visibilityReason:'Not visible in the current screenshot; scroll and observe before using this selector.'}:{})}));
 return result;
}

export function filterVisualActions(input,elements=[],{snapshot,allowedTypes,viewport,limit=Infinity,stopAfterClick=false,resolveCoordinates=true,fillOnly=false}={}){
 const source=Array.isArray(input)?input:[],bySelector=new Map(elements.map(element=>[element?.selector,element])),known=new Set(snapshotTargets(snapshot).map(target=>target?.selector)),actions=[],rejected=[];let clicked=false;
 const reject=(action,index,reason)=>rejected.push({index,type:String(action?.type||''),...(action?.selector?{selector:String(action.selector)}:{}),reason});
 for(const [index,sourceAction]of source.entries()){
  if(!sourceAction||typeof sourceAction!=='object'){reject(sourceAction,index,'invalid_action');continue;}
  let action={...sourceAction};
  if(allowedTypes&&!allowedTypes.has(action.type)){reject(action,index,'unsupported_type');continue;}
  if(clicked&&stopAfterClick){reject(action,index,'after_click_requires_observation');continue;}
  if(actions.length>=limit){reject(action,index,'action_limit');continue;}
  if(!['wait','scroll'].includes(action.type)){
   const x=Number(action.x),y=Number(action.y),coordinates=Number.isFinite(x)&&Number.isFinite(y)&&(!viewport||x>=0&&y>=0&&x<=viewport.width&&y<=viewport.height);
   if(resolveCoordinates&&action.type==='click'&&!action.selector&&coordinates){
    const matches=elements.filter(({rect})=>rect&&x>=rect.x&&y>=rect.y&&x<=rect.x+rect.width&&y<=rect.y+rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height);
    if(matches[0]?.selector)action.selector=matches[0].selector;
   }
   const target=bySelector.get(action.selector);
   if(!target&&!(action.type==='click'&&!fillOnly&&coordinates&&(!resolveCoordinates||!action.selector))){reject(action,index,action.selector?(known.has(action.selector)?'selector_not_visible':'unknown_selector'):'invalid_coordinates');continue;}
   if(fillOnly&&action.type==='click'&&finalControl.test(`${target?.label||''} ${target?.aria||''} ${target?.type||''}`)){reject(action,index,'final_submission_disallowed');continue;}
  }
  actions.push(action);if(action.type==='click')clicked=true;
 }
 return{actions,diagnostics:{inputCount:source.length,outputCount:actions.length,rejected,...(!source.length?{emptyReason:'model_returned_no_actions'}:{})}};
}
