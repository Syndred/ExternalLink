import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mediaLibrary} from '../executor/src/media-library.mjs';

const frozen=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),current=readFileSync(new URL('../executor/web/application.js',import.meta.url),'utf8');
const originalSource=frozen.slice(frozen.indexOf('  function resolveCloudMediaFiles('),frozen.indexOf('  function createMediaFileRow('));
const actualSource=current.slice(current.indexOf('function originalProductCloudFiles('),current.indexOf('async function renderProductMediaPreview('));
test('product cloud catalogue keeps frozen original profile identity matching, all files, metadata and order',()=>{
 const assets=[{asset_id:'old-unused',profile_id:'JEVPLAY',file_name:'old.gif',media_kind:'logo',content_type:'image/gif',byte_length:20},{asset_id:'by-name',profile_id:'jev play',file_name:'shot.svg',media_kind:'screenshot',content_type:'image/svg+xml',byte_length:40,media_index:2},{asset_id:'other',profile_id:'other',file_name:'other.png'},{asset_id:'non-image',profile_id:'JevPlay',file_name:'original.bin',content_type:'application/octet-stream'},{asset_id:'space',profile_id:' JevPlay ',file_name:'original-spelling.png'}],before=structuredClone(assets),product={id:'JevPlay',name:'Jev Play'};
 for(const input of [assets,[],null,{assets}]){
  const reference=vm.createContext({activeSiteId:product.id,siteProfiles:{[product.id]:product}}),actual=vm.createContext({product,assets:input});vm.runInContext(originalSource,reference);vm.runInContext(actualSource,actual);reference.assets=input;const expected=JSON.parse(JSON.stringify(vm.runInContext('resolveCloudMediaFiles(assets)',reference))),result=JSON.parse(JSON.stringify(vm.runInContext('originalProductCloudFiles(product,assets)',actual)));assert.deepEqual(result,expected);
 }
 assert.deepEqual(assets,before);
});
test('original product media refresh reads only the paginated catalogue and cannot depend on unrelated ledger availability',async()=>{
 const calls=[],runtime={cloud:{request:async route=>{calls.push(route);if(route==='workspace/media')return{assets:[{asset_id:'first',profile_id:'p'}],next:'next page'};if(route==='workspace/media?cursor=next%20page')return{assets:[{asset_id:'second',profile_id:'p'}]};throw Error('Original refresh must not read the complete ledger');}}};const result=await mediaLibrary(runtime,{catalogueOnly:true});assert.equal(result.ok,true);assert.deepEqual(result.assets.map(asset=>asset.asset_id),['first','second']);assert.deepEqual(calls,['workspace/media','workspace/media?cursor=next%20page']);assert.equal(result.references,undefined);
});
