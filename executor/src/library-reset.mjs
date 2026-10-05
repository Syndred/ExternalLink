import{enqueueApplicationPlan,flushApplicationMutations,pendingApplication}from'./application-mutations.mjs';
import{applicationData}from'./application-data.mjs';
export async function clearSiteAnnotation(runtime,input){
 if(input.confirmation!=='清除网站标记')throw Error('请确认清除网站标记');
 if(input.planId)return enqueueApplicationPlan(runtime,{planId:input.planId});
 await flushApplicationMutations(runtime);if(pendingApplication(runtime).length)throw Error('请先同步或解决已有编辑冲突');
 await applicationData(runtime,{refresh:true});
 return enqueueApplicationPlan(runtime,{operations:[{type:'clear_annotation',url:input.url},{type:'clear_deleted',url:input.url}]});
}
