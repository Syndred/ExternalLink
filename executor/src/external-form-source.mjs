import {getTargetInfo} from './browser-target.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {queue} from './shared.mjs';

// Source allowlist and URL rules from the frozen original bd916b2 background.
function normalizeSourceHost(value) {
  try {
    return new URL(String(value || "").trim()).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function trustedTypeformDestination(pageUrl, referrerUrl) {
  let page;
  try {
    page = new URL(String(pageUrl || ""));
  } catch {
    return null;
  }
  const pageHost = page.hostname.replace(/^www\./i, "").toLowerCase();
  if (pageHost !== "typeform.com" && !pageHost.endsWith(".typeform.com")) return null;
  // Only the known shared directory form is eligible for source attribution.
  // A query parameter alone is never enough because it can be copied into a
  // manually opened Typeform URL.
  if (!/^\/to\/rb6znef2$/i.test(page.pathname.replace(/%20/g, " "))) return null;
  let referrer;
  try {
    referrer = new URL(String(referrerUrl || ""));
  } catch {
    return null;
  }
  const sourceHost = normalizeSourceHost(referrer.href);
  if (!["aitools.inc", "startupstash.com"].includes(sourceHost)) return null;
  const querySource = page.searchParams.get("typeform-source") || page.searchParams.get("typeform_source") || "";
  if (querySource && normalizeSourceHost(/^https?:\/\//i.test(querySource) ? querySource : `https://${querySource}`) !== sourceHost) {
    return null;
  }
  const destination = new URL(referrer.href);
  destination.hash = "";
  destination.search = "";
  // The official AI Tools Inc link can set document.referrer to the home page.
  // Its directory ledger uses the submission page as the canonical key.
  if (sourceHost === "aitools.inc") destination.pathname = "/submit";
  return {
    destinationUrl: destination.toString(),
    sourceHost,
    referrerUrl: destination.toString(),
    formUrl: page.toString(),
  };
}

export function trustedExternalFormDestination(pageUrl, referrerUrl) {
  const typeform = trustedTypeformDestination(pageUrl, referrerUrl);
  if (typeform) return typeform;
  let page;
  try {
    page = new URL(String(pageUrl || ""));
  } catch {
    return null;
  }
  const pageHost = page.hostname.replace(/^www\./i, "").toLowerCase();
  const googleForm = pageHost === "docs.google.com" &&
    /^\/forms\/d\/e\/1FAIpQLSeuaZvj-s7KkI5Zp41q9LX0i9suH61c7JR2qe6sBdDtP9r9Sg\/viewform$/i.test(page.pathname);
  if (!googleForm) return null;
  let referrer;
  try {
    referrer = new URL(String(referrerUrl || ""));
  } catch {
    return null;
  }
  const sourceHost = normalizeSourceHost(referrer.href);
  if (sourceHost !== "aiinfinity-meetpatel.notion.site") return null;
  const destination = new URL(referrer.href);
  destination.hash = "";
  destination.search = "";
  return {
    destinationUrl: destination.toString(),
    sourceHost,
    referrerUrl: destination.toString(),
    formUrl: page.toString(),
  };
}

export function isStandaloneExternalFormUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return (
      host === "typeform.com" ||
      host.endsWith(".typeform.com") ||
      (host === "docs.google.com" && /^\/forms\/d\/e\/[^/]+\/viewform$/i.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

const AI_INFINITY_FORM_SHORT_URL = "https://forms.gle/Ze6pdWzmweCfKWnLA";
const EXTERNAL_FORM_SOURCE_MAX_AGE_MS = 10 * 60 * 1000;

const googleForm='https://docs.google.com/forms/d/e/1FAIpQLSeuaZvj-s7KkI5Zp41q9LX0i9suH61c7JR2qe6sBdDtP9r9Sg/viewform';
// Browser-owned creation events retain the directory when a short-link popup
// suppresses window.opener. Keep these transient, just like storage.session.
export async function observeExternalFormSources(runtime){
 const context=runtime.context,instance=runtime.host?.startedAt;
 if(runtime.externalFormSources?.context===context&&runtime.externalFormSources.instance===instance)return runtime.externalFormSources;
 await runtime.externalFormSources?.session.detach().catch(()=>{});
 const session=await context.browser().newBrowserCDPSession(),state={context,instance,session,targets:new Map(),created:new Map(),sources:new Map()},existing=new Set();runtime.externalFormSources=state;
 const capture=info=>{const birth=state.created.get(info.targetId);if(!birth||state.sources.has(info.targetId))return;
  if(info.url!==AI_INFINITY_FORM_SHORT_URL&&!trustedExternalFormDestination(info.url,'https://aiinfinity-meetpatel.notion.site/'))return;
  if(!trustedExternalFormDestination(googleForm,birth.sourceUrl))return;
  state.sources.set(info.targetId,{sourceTargetId:birth.sourceTargetId,sourceUrl:birth.sourceUrl,openingUrl:info.url,capturedAt:birth.at});
 };
 session.on('Target.targetCreated',({targetInfo:info})=>{state.targets.set(info.targetId,info);if(!existing.has(info.targetId)&&info.type==='page'&&info.openerId){const source=state.targets.get(info.openerId);state.created.set(info.targetId,{sourceTargetId:info.openerId,sourceUrl:source?.url||'',at:Date.now()});capture(info);}});
 session.on('Target.targetInfoChanged',({targetInfo:info})=>{state.targets.set(info.targetId,info);capture(info);});
 session.on('Target.targetDestroyed',({targetId})=>{state.targets.delete(targetId);state.created.delete(targetId);state.sources.delete(targetId);});
 try{for(const info of (await session.send('Target.getTargets')).targetInfos){state.targets.set(info.targetId,info);existing.add(info.targetId);}
 await session.send('Target.setDiscoverTargets',{discover:true});}catch(error){await session.detach().catch(()=>{});if(runtime.externalFormSources===state)runtime.externalFormSources=null;throw error;}
 // Discovery enumerates pre-existing targets as created; do not grant those a
 // new navigation timestamp. Direct referrer/opener lookup still works.
 return state;
}

async function browserReferrer(runtime,page){
 const session=await runtime.context.newCDPSession(page);
 try{const {frameTree}=await session.send('Page.getFrameTree'),{executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'ExternalLinkSourceAttribution',grantUniveralAccess:false});
  const result=await session.send('Runtime.evaluate',{expression:'({url:location.href,referrer:document.referrer})',contextId:executionContextId,returnByValue:true});
  if(result.exceptionDetails||result.result.value?.url!==page.url())throw Error('外部表单文档已变化，请重新检测');return result.result.value.referrer;
 }finally{await session.detach().catch(()=>{});}
}

export async function resolveExternalFormSource(runtime,page){
 const pageUrl=page.url();if(!isStandaloneExternalFormUrl(pageUrl))return null;
 const context=runtime.context,instance=runtime.host?.startedAt,scope=workbenchScope(runtime.store.get('pair'));
 const current=()=>{if(runtime.context!==context||runtime.host?.startedAt!==instance||workbenchScope(runtime.store.get('pair'))!==scope||page.isClosed()||page.url()!==pageUrl)throw Error('外部表单、浏览器或工作区已变化');};
 const direct=trustedExternalFormDestination(pageUrl,await browserReferrer(runtime,page));current();if(direct)return direct;
 const info=await getTargetInfo(context,page);current();if(!info)return null;
 // Only browser metadata can supply an opener; page query strings and messages
 // cannot assert a source target or directory.
 if(info.openerId&&info.canAccessOpener!==false){for(const source of context.pages()){if(!/^https?:\/\//.test(source.url()))continue;const sourceInfo=await getTargetInfo(context,source);current();if(sourceInfo?.targetId===info.openerId){const mapped=trustedExternalFormDestination(pageUrl,source.url());if(mapped)return mapped;break;}}}
 const state=runtime.externalFormSources,source=state?.context===context&&state.instance===instance&&state.sources.get(info.targetId);
 if(!source||Date.now()-source.capturedAt>EXTERNAL_FORM_SOURCE_MAX_AGE_MS)return null;
 for(const candidate of context.pages()){if(candidate.url()!==source.sourceUrl)continue;const target=await getTargetInfo(context,candidate);current();if(target?.targetId===source.sourceTargetId&&candidate.url()===source.sourceUrl)return trustedExternalFormDestination(pageUrl,source.sourceUrl);}
 return null;
}

export async function externalFormDestination(runtime,page){
 const source=await resolveExternalFormSource(runtime,page);
 if(isStandaloneExternalFormUrl(page.url())&&!source)throw Error('独立外部表单未确认来源目录，已停止归属；请从目录页重新打开或用「登记动态」补记');
 return source;
}

export function taskMatchesExternalForm(task,pageUrl){
 const source=task.externalFormSource;
 return !!source&&source.formUrl===pageUrl&&queue.normalizeDestinationKey(source.destinationUrl)===queue.normalizeDestinationKey(task.url)&&trustedExternalFormDestination(pageUrl,source.referrerUrl)?.destinationUrl===source.destinationUrl;
}
