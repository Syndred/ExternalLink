import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const functions=['copyCommentDraft','makeCommentSnapshot','commentSnapshotKey','handleCommentTextInput','restoreCommentHistory','captureCommentState','selectCommentDraft'].map(name=>{const match=source.match(new RegExp('^  function '+name+'\\([^]*?^  \\}','m'));if(!match)throw Error('Original comment handler missing '+name);return match[0];}).join('\n');
export function originalCommentRestoration(drafts,edits){
 const nodes={spCommentText:{value:drafts[0]?.text||''},commentTone:{value:'professional'}},context=vm.createContext({Date,Math,$:id=>nodes[id],commentDrafts:structuredClone(drafts),selectedCommentDraft:0,commentHistory:[],updateCommentCharCount(){},renderCommentDrafts(){},renderCommentHistory(){},showToast(){}});
 vm.runInContext(functions,context);context.commentHistory=[context.makeCommentSnapshot('原保存版本')];
 for(const[index,text]of Object.entries(edits)){context.selectedCommentDraft=Number(index);nodes.spCommentText.value=text;context.handleCommentTextInput();}
 const edited=context.makeCommentSnapshot('编辑后');context.restoreCommentHistory(0);
 return JSON.parse(JSON.stringify({edited,restoredDrafts:context.commentDrafts,restoredText:nodes.spCommentText.value,history:context.commentHistory}));
}

export function originalCommentSelection(drafts,edits){
 const nodes={spCommentText:{value:drafts[0]?.text||''},commentTone:{value:'professional'}},context=vm.createContext({Date,Math,$:id=>nodes[id],commentDrafts:structuredClone(drafts),selectedCommentDraft:0,commentHistory:[],updateCommentCharCount(){},renderCommentDrafts(){},renderCommentHistory(){},showToast(){}});
 vm.runInContext(functions,context);
 for(const [index,text]of Object.entries(edits)){context.selectCommentDraft(Number(index));nodes.spCommentText.value=text;context.handleCommentTextInput();}
 return JSON.parse(JSON.stringify({selected:context.selectedCommentDraft,text:nodes.spCommentText.value,drafts:context.commentDrafts,history:context.commentHistory}));
}

export function originalCommentHistoryRules(drafts,steps,{restoreVersions,restoreIndex}={}){
 const nodes={spCommentText:{value:drafts[0]?.text||''},commentTone:{value:'professional'}},context=vm.createContext({Date,Math,$:id=>nodes[id],commentDrafts:structuredClone(drafts),selectedCommentDraft:0,commentHistory:[],updateCommentCharCount(){},renderCommentDrafts(){},renderCommentHistory(){},showToast(){}});
 vm.runInContext(functions,context);
 for(const step of steps){context.selectCommentDraft(step.index);if(typeof step.text==='string'){nodes.spCommentText.value=step.text;context.handleCommentTextInput();}}
 const current=context.makeCommentSnapshot('恢复前');
 if(restoreVersions){context.commentHistory=structuredClone(restoreVersions);context.restoreCommentHistory(restoreIndex);}
 return JSON.parse(JSON.stringify({current,selected:context.selectedCommentDraft,text:nodes.spCommentText.value,drafts:context.commentDrafts,history:context.commentHistory}));
}

export function originalSnapshotRestoreTransition(current,history,index){
 const nodes={spCommentText:{value:current.text||''},commentTone:{value:current.tone||'helpful'}},context=vm.createContext({Date,Math,$:id=>nodes[id],commentDrafts:structuredClone(current.drafts),selectedCommentDraft:current.selected??-1,commentHistory:structuredClone(history),updateCommentCharCount(){},renderCommentDrafts(){},renderCommentHistory(){},showToast(){}});
 vm.runInContext(functions,context);context.restoreCommentHistory(index);
 return JSON.parse(JSON.stringify({history:context.commentHistory,active:{drafts:context.commentDrafts,selected:context.selectedCommentDraft,text:nodes.spCommentText.value,tone:nodes.commentTone.value}}));
}
