import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Load only the three relevant committed modules without rewriting live files.
// Dependencies, the isolated browser and authenticated storage fixtures remain
// identical to the current run, so a missing handoff is attributable to source.
export async function originalNativeReceiptRuntime(){
 const names=new Set(['runtime.mjs','acceptance-cleanup.mjs','original-agent-unavailable.mjs']),cache=new Map();
 function moduleUrl(name){
  if(cache.has(name))return cache.get(name);
  const file=resolve('executor/src',name),base=pathToFileURL(file),require=createRequire(base);
  let source=execFileSync('git',['show','485b8ad:executor/src/'+name],{encoding:'utf8',maxBuffer:4*1024*1024});
  source=source.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(match,quote,specifier)=>{
   const resolved=specifier.startsWith('./')&&names.has(specifier.slice(2))?moduleUrl(specifier.slice(2)):specifier.startsWith('.')?new URL(specifier,base).href:specifier.startsWith('node:')?specifier:specifier==='playwright'?new URL('index.mjs',pathToFileURL(require.resolve(specifier))).href:pathToFileURL(require.resolve(specifier)).href;
   return 'from '+JSON.stringify(resolved);
  }).replaceAll('import.meta.url',JSON.stringify(base.href));
  const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(name,url);return url;
 }
 return(await import(moduleUrl('runtime.mjs'))).Runtime;
}
