// Read-only reproduction of the production observe callback against a frame
// that hydrates between detectPage and getPageSnapshot. No browser or service.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Runtime} from '../../executor/src/runtime.mjs';
import {assessSubmissionQuality} from '../../executor/src/quality.mjs';
const source=Runtime.prototype.prepareWithAi.toString(),start=source.indexOf('const observe=async()=>{'),end=source.indexOf('\n    const ready=async()=>{',start);assert.ok(start>=0&&end>start);
const mode=process.argv[2]||'hydrating',complete=mode==='prior-complete';
let detects=0,smartFills=0;const calls=[],fields=['Your Name','Your Email','Tool Name',"Tool’s Link",'Tool category','Short Description','Additional Notes'].map((label,index)=>({selector:'#field'+index,label,type:index===1?'email':index>=5?'textarea':'text',required:true,value:{present:complete,kind:'text',length:complete?10:0}}));
const child={url:()=> 'https://tally.so/embed/n9BqRX',isDetached:()=>false},parent={url:()=> 'https://aitoolslist.io/submit-ai-tool/'};
const engine={documentId:301,detach:async()=>{},call:async input=>{
 calls.push(input.action);if(input.action==='detectPage'){detects++;const operable=mode!=='still-unrecognized'&&(complete||detects>1);return{operable,formFieldCount:operable?7:0,platform:'unknown'};}
 if(input.action==='getPageSnapshot')return{url:child.url(),fields};
 if(input.action==='smartFill'){smartFills++;return{ok:true,filledCount:7,mappings:{}};}
 if(input.action==='getFilledFieldsReport')return{fields:complete?[{label:'Tool Name',value:'OldPhotoLive AI'},{label:"Tool’s Link",value:'https://oldphotoliveai.com'}]:[],allValid:true};
 if(input.action==='collectFormValidation')return{validationFailed:!complete,emptyCount:complete?0:7};
 if(input.action==='inspectSubmitAction')return{finalFound:true,allowed:true};
 throw Error('Unexpected callback '+input.action);
}};
const task={id:'readonly-fixture',profileSnapshot:{name:'OldPhotoLive AI',fields:{Name:'OldPhotoLive AI',Url:'https://oldphotoliveai.com'}},...(mode==='final-attempt'?{attemptBoundary:'keep-original-final',aiTakeover:{submissionPhase:{entry:{submissionAttempted:true}}}}:{})},sandbox=vm.createContext({task,page:{frames:()=>[child],mainFrame:()=>parent},candidate:null,bound:true,normalDone:['prior-empty','prior-complete'].includes(mode),normalPreparationDocument:null,assessSubmissionQuality,preparationConfig:{fillOnly:true},config:{brandName:'OldPhotoLive AI',targetDomain:'oldphotoliveai.com'},active:()=>true,assertCurrent:async()=>{},assertDocument:async()=>{},nativeNavigationSnapshotError:()=>false,attachEngine:async()=>engine,adapter:{snapshot:async()=>({})}});
const observe=vm.runInContext('('+source.slice(start,end).replace(/^const observe=/,'').replace(/;\s*$/,'')+')',sandbox),runtime={preparePublicPage:async()=>{},context:{},bridge:async()=>{},reconcileTextInputs:async()=>{},update(t,patch){Object.assign(t,patch);}};
Object.assign(sandbox,runtime);let snapshot=await observe();if(mode.startsWith('repeat-')){if(mode==='repeat-new-document')engine.documentId++;snapshot=await observe();}const quality=assessSubmissionQuality({fields:[{label:'Your Name',value:'Syndred'}]},{name:'OldPhotoLive AI',fields:{Name:'OldPhotoLive AI',Url:'https://oldphotoliveai.com'}});
console.log(JSON.stringify({kind:'iframe_hydration_observation_order_reproduction',mode,observedFields:snapshot.fields.length,detectCalls:detects,smartFillCalls:smartFills,calls,missingNormalPreparation:!task.normalPreparation,observation:task.originalAgentObservation,expectedSmartFillCalls:1,redReproduced:smartFills===0&&snapshot.fields.length===7,qualityCorrectlyRejectsContactOnly:quality.some(reason=>reason.includes('没有核实')),attemptBoundary:task.attemptBoundary,externalRequests:0,browserOperations:0,productionWrites:0,liveCauseConfirmed:false}));
