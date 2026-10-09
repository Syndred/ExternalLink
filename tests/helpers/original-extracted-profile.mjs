import {execFileSync} from 'node:child_process';import vm from 'node:vm';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/profiles.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),context=vm.createContext({Date,console,URL});context.self=context;vm.runInContext(source,context);
export function originalExtractedProfile(current,extracted){return structuredClone(context.ExtLinkProfiles.mergeExtractedProfile(structuredClone(current),structuredClone(extracted)));}
