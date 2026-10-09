import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Load only the relevant committed modules without rewriting live files.
// Dependencies, the isolated browser and authenticated storage fixtures remain
// identical to the current run, so a missing handoff is attributable to source.
export const originalNativeReceiptRuntime=()=>nativeRuntimeAt('485b8ad',['runtime.mjs','acceptance-cleanup.mjs','original-agent-unavailable.mjs']);
export const originalNativeSkipScopeRuntime=()=>nativeRuntimeAt('bfa80b9',['runtime.mjs','manual-controls.mjs']);
export const originalNativeIndependentReceiptRuntime=()=>nativeRuntimeAt('85b6297',['runtime.mjs','acceptance-cleanup.mjs']);
async function nativeRuntimeAt(ref,modules){
 const names=new Set(modules),cache=new Map();
 function moduleUrl(name){
  if(cache.has(name))return cache.get(name);
  const file=resolve('executor/src',name),base=pathToFileURL(file),require=createRequire(base);
  let source=execFileSync('git',['show',ref+':executor/src/'+name],{encoding:'utf8',maxBuffer:4*1024*1024});
  source=source.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(match,quote,specifier)=>{
   const resolved=specifier.startsWith('./')&&names.has(specifier.slice(2))?moduleUrl(specifier.slice(2)):specifier.startsWith('.')?new URL(specifier,base).href:specifier.startsWith('node:')?specifier:specifier==='playwright'?new URL('index.mjs',pathToFileURL(require.resolve(specifier))).href:pathToFileURL(require.resolve(specifier)).href;
   return 'from '+JSON.stringify(resolved);
  }).replaceAll('import.meta.url',JSON.stringify(base.href));
  const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(name,url);return url;
 }
 return(await import(moduleUrl('runtime.mjs'))).Runtime;
}
