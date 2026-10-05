import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repo } from './shared.mjs';

// The same production field mapper, validation and evidence classifier runs in
// a separate CDP isolated world. No credential is placed in the site's realm.
const sources = await Promise.all(['profiles.js', 'playbooks.js', 'form-engine.js'].map(name => readFile(path.join(repo, 'core', name), 'utf8')));
export async function attachEngine(context, frame, bridge = async () => ({ ok: false }),options={}) {
  if(!/^https?:\/\//.test(frame.url()))throw Error('表单引擎仅允许普通 HTTP/HTTPS 页面');
  let session;
  try { session = await context.newCDPSession(frame); }
  catch (error) {
    if (!/part of the parent frame's session/.test(error.message)) throw error;
    session = await context.newCDPSession(frame.page());
  }
  const tree = await session.send('Page.getFrameTree');
  let frameUrl = frame.url();
  if (!frameUrl) {
    const info = (await session.send('Target.getTargetInfo')).targetInfo;
    if (info.type === 'iframe' && info.targetId === tree.frameTree.frame.id) frameUrl = tree.frameTree.frame.url;
  }
  const ancestry = [];
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) ancestry.unshift(current.parentFrame().childFrames().indexOf(current));
  let target = tree.frameTree;
  for (const index of ancestry) target = target?.childFrames?.[index];
  // An OOP iframe has its own CDP target rooted at that frame; a same-process
  // iframe shares the page session and must be resolved through the frame tree.
  if (!target || target.frame.url !== frameUrl) {
    const matches=[];
    const visit=node=>{if(node.frame.url===frameUrl && (!frame.name() || node.frame.name===frame.name()))matches.push(node);for(const child of node.childFrames||[])visit(child);};
    visit(tree.frameTree);
    if(matches.length===1)target=matches[0];
  }
  if (!target || target.frame.url !== frameUrl) { await session.detach(); throw new Error(`iframe 身份已变化，请重新观察：${frameUrl} / CDP ${tree.frameTree.frame.url}`); }
  const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: target.frame.id, worldName: 'ExternalLinkExecutor', grantUniveralAccess: false });
  const evaluate = async (expression, awaitPromise = true) => {
    const result = await session.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await session.send('Runtime.addBinding', { name: '__executorRpc', executionContextId });
  session.on('Runtime.bindingCalled', async event => {
    if (event.name !== '__executorRpc' || event.executionContextId !== executionContextId) return;
    const { id, message } = JSON.parse(event.payload);
    let response;
    try { response = await bridge({...message,executorDocumentId:executionContextId}); } catch (error) { response = { ok: false, error: error.message }; }
    await evaluate(`globalThis.__executorReplies.get(${id})?.(${JSON.stringify(response)});globalThis.__executorReplies.delete(${id})`, false).catch(() => {});
  });
  await evaluate(`globalThis.__extLinkDisableManualIcons?.();globalThis.__executorReplies=new Map(); globalThis.__executorSeq=globalThis.__executorSeq||0;
    globalThis.__externalLinkServices={authorized:true,persistLearning:true,interactive:${options.interactive===true},
      register(fn){globalThis.__executorHandler=fn},unregister(){globalThis.__executorHandler=null},
      request(message){if(!['log','fetchSubmissionMedia','fetchCloudSubmissionMedia','generateCommentDrafts','saveFillLearnings'${options.interactive===true?",'getActiveFillConfig','contentReady','manualSubmissionWatchRequest','manualSubmissionWatchReady','manualSubmissionClicked'":''}].includes(message.action))return Promise.resolve({ok:false});
        return new Promise(resolve=>{const id=++globalThis.__executorSeq;__executorReplies.set(id,resolve);__executorRpc(JSON.stringify({id,message}));})}
    };`);
  for (const source of sources) await evaluate(source, false);
  if(options.interactive===true)await evaluate('globalThis.__extLinkOnPageNavigation?.()',false);
  return {
    documentId:executionContextId,
    assistantActive:()=>evaluate('globalThis.__externalLinkServices?.interactive===true'),
    disableAssistant:()=>evaluate('globalThis.__extLinkDisableManualIcons?.()'),
    call: message => evaluate(`new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('共享表单引擎操作超时')),45000);try{const handled=__executorHandler(${JSON.stringify(message)},null,value=>{clearTimeout(timeout);resolve(value)});if(!handled){clearTimeout(timeout);reject(new Error('未知表单操作'))}}catch(e){clearTimeout(timeout);reject(e)}})`),
    detach: () => session.detach().catch(() => {}),
  };
}
