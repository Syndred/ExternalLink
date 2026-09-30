import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '../executor/node_modules/playwright/index.mjs';

test('library range selects the same executor without starting or retaining a stale preview', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="panel-workbench"></main>');
    await page.evaluate(() => {
      window.requests=[];
      window.chrome={storage:{local:{get:async()=>({executorConnection:{endpoint:'http://127.0.0.1:19388',localToken:'test'},siteProfiles:{JevPlay:{name:'JevPlay'}},activeSiteId:'JevPlay'}),set:async()=>{}}}};
      window.fetch=async(url,options)=>{
        window.requests.push({path:new URL(url).pathname,body:options.body});
        const path=new URL(url).pathname;
        if(path==='/preview'&&window.delayPreview)await new Promise(resolve=>window.resolvePreview=resolve);
        const data=path==='/catalog'?{ok:true,profiles:{JevPlay:{name:'JevPlay'}}}:path==='/preview'?{ok:true,preview:{id:'p',profileId:'JevPlay',profileRevision:1,total:1,sources:{cloudTableRows:1,bundledTableRows:0,cloudUrlListRows:0},tasks:[{url:'https://one.test/submit'}],exclusions:[],profile:{fields:{}}}}:{ok:true,paused:true,runs:[],tasks:[{id:'pending',profileId:'JevPlay',url:'https://pending.test',status:'pending'},{id:'manual',profileId:'JevPlay',url:'https://manual.test',status:'needs_manual'},{id:'received',profileId:'JevPlay',url:'https://received.test',status:'finished',attemptBoundary:'saved',receipt:{evidence:'received'},cloudVerified:true}],pendingEvents:0};
        return {ok:true,json:async()=>data};
      };
    });
    await page.addScriptTag({path:'extension/executor-panel.js'});
    await page.waitForFunction(()=>document.querySelector('#executor-profile').value==='JevPlay');
    await page.click('#executor-preview');
    await page.waitForFunction(()=>!document.querySelector('#executor-start').disabled);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('externallink:select-range',{detail:{profileId:'JevPlay',urls:['https://two.test/submit'],label:'当前筛选'}})));
    assert.equal(await page.inputValue('#executor-urls'),'https://two.test/submit');
    assert.equal(await page.isDisabled('#executor-start'),true);
    assert.equal(await page.locator('#panel-workbench > #executor-workbench').count(),1);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.path==='/start').length),0);
    assert.equal(await page.isVisible('#executor-resume'),true);
    assert.equal(await page.isVisible('#executor-pause'),false);
    const manual=page.locator('.executor-task').filter({hasText:'https://manual.test'});
    assert.equal(await manual.isVisible(),true);
    assert.equal(await manual.getByRole('button',{name:'核验回执'}).count(),0);
    const received=page.locator('.executor-task').filter({hasText:'https://received.test'});
    assert.equal(await received.getByRole('button',{name:'接管本站'}).count(),0);
    assert.equal(await page.locator('.executor-task').filter({hasText:'https://pending.test'}).isVisible(),false);
    await page.click('#executor-preview');
    await page.waitForFunction(()=>!document.querySelector('#executor-start').disabled);
    await page.fill('#executor-limit','10');
    assert.equal(await page.isDisabled('#executor-start'),true);
    await page.evaluate(()=>window.delayPreview=true);
    await page.click('#executor-preview');
    await page.waitForFunction(()=>!!window.resolvePreview);
    await page.fill('#executor-urls','https://changed.test');
    await page.evaluate(()=>window.resolvePreview());
    await page.waitForFunction(()=>document.querySelector('#executor-status').textContent==='范围已修改，请重新预览。');
    assert.equal(await page.isDisabled('#executor-start'),true);
  } finally {await browser.close();}
});

test('primary navigation exposes one batch engine and maintenance is folded away', () => {
  const side=readFileSync('extension/sidepanel.html','utf8'),settings=readFileSync('extension/settings.html','utf8');
  assert.match(side,/data-panel="workbench"/);
  assert.doesNotMatch(side,/data-panel="batch"/);
  assert.doesNotMatch(side,/id="btnStart"/);
  assert.doesNotMatch(side,/id="btnStartLibraryGroup"|id="btnStartLibraryCategory"/);
  assert.match(side,/id="btnUseLibraryFilter"/);
  assert.doesNotMatch(settings,/<script src="executor-panel.js"/);
  assert.match(settings,/id="panel-journal"/);
  assert.match(readFileSync('extension/popup.html','utf8'),/sidepanel.html/);
});

test('complete pages switch panels, keep buttons bound and pass library scope without an old start action', async () => {
  const browser=await chromium.launch({headless:true});
  const inventories={};
  mkdirSync('docs/evidence/ui-simplification-2026-09-30',{recursive:true});
  try {
    for (const surface of ['sidepanel','settings','web']) {
      const page=await browser.newPage({viewport:{width:surface==='sidepanel'?430:1280,height:900}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{
        const original=EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener=function(type,...args){(this.__uiEvents??=[]).push(type);return original.call(this,type,...args);};
        const profile={id:'JevPlay',name:'JevPlay',fields:{Name:'JevPlay',Url:'https://jevplay.com'}};
        const data={siteProfiles:{JevPlay:profile},activeSiteId:'JevPlay',executorConnection:{endpoint:'http://127.0.0.1:19388',localToken:'test'},cloudSyncConfig:{endpoint:'https://cloud.test',workspaceId:'test'},submissionRecords:{},submissionTimeline:[],d1JournalPending:[]};
        const event={addListener:()=>{}};
        window.messages=[];
        window.chrome={storage:{local:{get:(keys,cb)=>{if(cb)cb(data);return Promise.resolve(data);},set:async value=>Object.assign(data,value)},onChanged:event},windows:{getCurrent:async()=>({id:1})},tabs:{query:async()=>[],onActivated:event,onUpdated:event,onRemoved:event},runtime:{getURL:path=>'http://ui.test/extension/'+path,openOptionsPage:async()=>{},onMessage:event,sendMessage:async msg=>{messages.push(msg);return{ok:true,items:[{key:'one',url:'https://one.test/submit',domain:'one.test',name:'One',category:'其他目录',accessModel:'free',annotation:{}}],tasks:[],profiles:{JevPlay:profile},documents:data,events:[],records:{},timeline:[],config:{},filters:{},blacklist:[],media:[],files:[],stats:{done:0,skip:0,err:0,total:0},status:'idle'};}}};
      });
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        const path=url.pathname;
        if(url.hostname==='ui.test'&&(path.endsWith('.js')||path.endsWith('.css')||path.endsWith('.html')||path.endsWith('.png')||path==='/')) {
          const file=path==='/'?'executor/web/index.html':path==='/app.js'?'executor/web/app.js':path.slice(1);
          await route.fulfill({body:readFileSync(resolve(file)),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'text/html'});return;
        }
        const documents={siteProfiles:{JevPlay:{id:'JevPlay',name:'JevPlay',fields:{Name:'JevPlay',Url:'https://jevplay.com'}}},submissionRecords:{},submissionTimeline:[]};
        await route.fulfill({json:{ok:true,paused:true,runs:[],tasks:[],pendingEvents:0,pending:[],profiles:documents.siteProfiles,documents,revisions:{siteProfiles:1},endpoint:'https://cloud.test',workspaceId:'test'}});
      });
      await page.goto(surface==='web'?'http://ui.test/':'http://ui.test/extension/'+surface+'.html');
      if(surface==='sidepanel') {
        await page.waitForSelector('#executor-profile option',{state:'attached'});
        assert.equal(await page.isVisible('#executor-workbench'),true);
        assert.equal(await page.isVisible('#panel-home'),false);
        await page.click('[data-panel="library"]');
        await page.waitForFunction(()=>!document.querySelector('#btnUseLibraryFilter').disabled);
        await page.click('#btnUseLibraryFilter');
        assert.deepEqual(errors,[],surface+' has no unhandled UI errors');
        assert.equal(await page.isVisible('#executor-workbench'),true);
        assert.equal(await page.inputValue('#executor-urls'),'https://one.test/submit');
        assert.equal(await page.evaluate(()=>messages.some(m=>m.action==='start')),false);
      } else if(surface==='settings') {
        await page.click('[data-panel="journal"]');
        assert.equal(await page.isVisible('#submission-journal'),true);
        assert.equal(await page.locator('#executor-workbench').count(),0);
        await page.click('[data-panel="sites"]');
        assert.equal(await page.isVisible('#submission-journal'),false);
      } else {
        await page.waitForSelector('#submission-journal',{state:'attached'});
        assert.equal(await page.isVisible('#submission-journal'),false);
        await page.click('[data-view="journal"]');
        assert.equal(await page.isVisible('#submission-journal'),true);
        assert.equal(await page.isVisible('#executor-workbench'),false);
        await page.click('[data-view="workbench"]');
      }
      inventories[surface]=await page.evaluate(()=>[...document.querySelectorAll('button')].map(button=>({id:button.id,label:button.textContent.trim(),type:button.type,events:button.__uiEvents||[],onclick:!!button.onclick,form:!!button.form,hidden:!!button.closest('[hidden]'),disabled:button.disabled})));
      await page.screenshot({path:'docs/evidence/ui-simplification-2026-09-30/'+surface+'.png',fullPage:true});
      assert.deepEqual(errors,[],surface+' has no unhandled UI errors');
      await page.close();
    }
    writeFileSync('docs/evidence/ui-simplification-2026-09-30/button-inventory.json',JSON.stringify({environment:'isolated browser with mocked Chrome and cloud APIs; no real submissions',surfaces:inventories},null,2));
  } finally {await browser.close();}
});
