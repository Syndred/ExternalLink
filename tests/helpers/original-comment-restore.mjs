import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const functions=['copyCommentDraft','makeCommentSnapshot','commentSnapshotKey','handleCommentTextInput','restoreCommentHistory'].map(name=>{const match=source.match(new RegExp('^  function '+name+'\\([^]*?^  \\}','m'));if(!match)throw Error('Original comment handler missing '+name);return match[0];}).join('\n');
export function originalCommentRestoration(drafts,edits){
 const nodes={spCommentText:{value:drafts[0].text},commentTone:{value:'professional'}},context=vm.createContext({Date,Math,$:id=>nodes[id],commentDrafts:structuredClone(drafts),selectedCommentDraft:0,commentHistory:[],updateCommentCharCount(){},renderCommentDrafts(){},renderCommentHistory(){},showToast(){}});
 vm.runInContext(functions,context);context.commentHistory=[context.makeCommentSnapshot('原保存版本')];
 for(const[index,text]of Object.entries(edits)){context.selectedCommentDraft=Number(index);nodes.spCommentText.value=text;context.handleCommentTextInput();}
 const edited=context.makeCommentSnapshot('编辑后');context.restoreCommentHistory(0);
 return JSON.parse(JSON.stringify({edited,restoredDrafts:context.commentDrafts,history:context.commentHistory}));
}
