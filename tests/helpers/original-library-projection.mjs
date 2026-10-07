import {createHash} from 'node:crypto';
import {applicationModel} from '../../core/application-model.mjs';
import {originalLibraryCatalog,originalLibraryGlobals as original,originalTimelineWithDateParser} from './original-library-catalog.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

const fields=['url','domain','name','category','language','accessModel','tags','note','record','detail','rawFields','rowNumber','projects','time','annotation','quality','monitorStatus','metrics','preferences','profileStatuses','events','latestEvent','groups','progress'];
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const dateDecodedOriginal=originalTimelineWithDateParser(globalThis.ExtLinkSubmissionTimeline.parseTime);
function projection(item){
 const value={...item,annotation:item.annotation||{},preferences:item.preferences||item.library,
  groups:item.groups||original.ExtLinkLibraryGroups.GROUPS.filter(([id])=>original.ExtLinkLibraryGroups.matches(item,id)).map(([id])=>id),
  progress:item.progress||original.ExtLinkSubmissionTimeline.deriveLibraryProgress(item)};
 return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
export async function compareOriginalLibraryProjection(snapshot){
 const sourceHash=hash(snapshot),reference=await originalLibraryCatalog(snapshot),model=applicationModel(snapshot),actual=new Map(model.library.map(item=>[item.url,item])),expectedUrls=new Set(reference.items.map(item=>item.url)),mismatches=[],expectedRows=[],actualRows=[],decodedRows=[],unexplainedMismatches=[];
 for(const row of reference.items){
  const expected=projection(row),current=actual.get(row.url),observed=current&&projection(current);expectedRows.push(expected);if(observed)actualRows.push(observed);
  const decoded={...expected,progress:dateDecodedOriginal.deriveLibraryProgress(row)};decodedRows.push(decoded);
  for(const field of fields)if(!current||batchJson(expected[field]??null)!==batchJson(observed[field]??null)){
   const difference={destinationSha256:hash(row.url),field};mismatches.push(difference);
   if(field!=='progress'||batchJson(decoded.progress)!==batchJson(observed.progress))unexplainedMismatches.push(difference);
  }
 }
 for(const row of model.library)if(!expectedUrls.has(row.url)){const difference={destinationSha256:hash(row.url),field:'unexpected_destination'};mismatches.push(difference);unexplainedMismatches.push(difference);}
 return{sourceUnchanged:hash(snapshot)===sourceHash,originalBaseline:'bd916b2944a577b160a6afcb8a7d73d263044c0c',referenceRows:reference.items.length,currentRows:model.library.length,fieldsCompared:fields,comparisons:reference.items.length*fields.length,mismatches,unexplainedMismatches,originalDateDecodedProjectionSha256:hash(decodedRows),referenceProjectionSha256:hash(expectedRows),currentProjectionSha256:hash(actualRows),facts:{products:model.products.length,storedReceipts:Object.keys(snapshot.documents.submissionRecords||{}).length,storedTimelineEvents:Object.values(snapshot.documents.submissionTimeline||{}).flat().length,favorites:model.library.filter(item=>item.preferences.favorite).length,highQualityGroup:model.library.filter(item=>item.groups.includes('high_quality')).length,freeSubmitGroup:model.library.filter(item=>item.groups.includes('free_submit')).length,rowsWithDr:model.library.filter(item=>item.metrics.dr!=null).length}};
}
