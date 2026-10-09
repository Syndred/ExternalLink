import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import vm from 'node:vm';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const functions=['renderCommentHistory','formatCommentHistoryTime'].map(name=>source.match(new RegExp('^  function '+name+'\\([^]*?^  \\}','m'))?.[0]||assert.fail('Missing frozen original '+name)).join('\n');
test('complete frozen original history renderer has empty, raw, selected candidate and candidate-set previews',()=>{
 const makeNode=()=>({children:[],dataset:{},append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes}}),list=makeNode(),restore={};
 const context=vm.createContext({Date,commentHistory:[],$:id=>id==='commentHistory'?list:restore,document:{createElement:makeNode}});vm.runInContext(functions,context);context.renderCommentHistory();assert.equal(restore.disabled,true);assert.equal(list.children[0].textContent,'生成或编辑后，这里会保留上一版');
 context.commentHistory=[{label:'恢复前',at:0,text:'原文',drafts:[]},{at:0,text:'',selected:1,drafts:[{text:'一'},{text:'二'}]},{at:0,text:'',drafts:[]}];context.renderCommentHistory();assert.equal(restore.disabled,false);const previews=['原文','二','候选集'];list.children.forEach((row,index)=>{assert.ok(row.children[0].textContent.endsWith(' · '+previews[index]));assert.equal(row.children[1].dataset.commentHistoryIndex,String(index));assert.equal(row.children[1].title,index===0?'恢复 恢复前':'恢复 上一版');});
});
test('actual comment history UI previews and restores a chosen older version without losing unsaved edits',{timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-comment-history-panel.mjs'],{encoding:'utf8',timeout:40000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','emptyHistoryAndDisabledRestore','historyRawPreviewVisible','selectedCandidatePreviewFallback','candidateSetPlaceholderVisible','originalLabelsAndRestoreTitle','specificOlderHistoryUiClick','unsavedTextSavedBeforeRestore','failedSaveKeepsDraftAndHistory','sqliteReopenAndUiReload','originalBusinessUnchanged','originalChromeUntouched'])assert.equal(proof[key],true);assert.equal(proof.productionWrites+proof.realSubmissions+proof.realModelCalls,0);
});
