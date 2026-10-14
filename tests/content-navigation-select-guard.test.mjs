import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import vm from 'node:vm';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {attachEngine} from '../executor/src/engine.mjs';

const sources=['core/form-engine.js','extension/content.js'].map(path=>readFileSync(new URL('../'+path,import.meta.url),'utf8').replace(/\r\n/g,'\n'));
const start='  function isNonSubmissionUtilityField(',end='  // ─── Waiting banner overlay';
const functions=sources.map(source=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))));
const form={},context=vm.createContext({document:{},hasLikelyListingFields:()=>true,hasLikelySubmissionFields:()=>true,
  getFieldHint:element=>element.label+' '+element.name,getSnapshotLabel:element=>element.label});
vm.runInContext(functions[0],context);

function select({id='category',name='category',widget=false,handler=''}={}){
  return {tagName:'SELECT',type:'select-one',label:'Product category',id,name,
    getAttribute:key=>key==='onchange'?handler:null,
    closest:selector=>selector==='form'?form:widget&&selector.includes('.widget_categories')?{}:null};
}

test('WordPress taxonomy widgets and explicit onchange navigation are utility controls, including beside a product form',()=>{
  for(const element of [select({id:'wp-block-categories-1',name:'cat',widget:true}),
    select({id:'cat',name:'cat',widget:true}),
    select({handler:'window.location.href = this.value'}),
    select({handler:'location.assign(this.options[this.selectedIndex].value)'}),
    select({handler:'document.location.replace(this.value)'})]){
    assert.equal(context.isNonSubmissionUtilityField(element),true);
  }
});

test('real product Category, Pricing, Type and non-navigating dependent selects remain fillable',()=>{
  for(const element of [select(),select({id:'pricing',name:'pricing'}),select({id:'type',name:'product_type'}),
    select({id:'cat',name:'cat'}),select({handler:'updateSubCategories(this.value)'}),
    select({handler:'productState.location = this.value'}),
    select({handler:'console.log("location.href = /archive")'}),
    select({handler:'/* location.href = /archive */ updateSubCategories(this.value)'})]){
    assert.equal(context.isNonSubmissionUtilityField(element),false);
  }
  assert.equal(functions[0],functions[1],'standalone and extension copies must share the navigation guard');
});

test('isolated real DOM smartFill leaves category navigation unchanged and fills form and supplemental product categories',async t=>{
  let posts=0,externalRequests=0,navigations=0;const navigationPaths=[];
  const server=createServer((request,response)=>{
    if(request.method!=='GET'){posts++;response.writeHead(405).end();return;}
    if(request.url.startsWith('/archive')){navigations++;navigationPaths.push(request.url);}
    response.setHeader('Content-Type','text/html');
    const noForm=request.url.startsWith('/no-form');
    response.end(`<!doctype html><title>Submit a local product</title><style>label,select{display:block;margin:12px}select{width:180px;height:28px}</style>
      ${noForm?'<main>':'<form id="product-submission">'}
      <label>Product name<input name="product_name" value="Fixture Tool"></label>
      <label>Website<input type="url" name="website" value="https://product.invalid/"></label>
      <label>Product category<select id="product-category" name="product_category"><option value="">Select category</option><option value="video">Video Generator</option><option value="image">Image Editing</option></select></label>
      <label>Product Pricing<select id="product-pricing" name="pricing"><option>Free</option><option>Freemium</option><option>Paid</option></select></label>
      <label>Product Type<select id="product-type" name="product_type"><option value="">Select type</option><option value="web">Web App</option><option value="desktop">Desktop App</option></select></label>
      ${noForm?'</main>':'</form>'}
      <section><label>Discovery category<select id="discovery-category" name="discovery_category"><option value="">Select category</option><option value="video">Video Generator</option><option value="image">Image Editing</option></select></label></section>
      <aside class="widget_categories"><div class="wp-block-categories-dropdown wp-block-categories"><label for="wp-block-categories-1">Categories</label>
        <select name="cat" id="wp-block-categories-1" class="postform"><option value="-1">Select Category</option><option value="63">Video Generator</option><option value="66">Image Editing</option></select></div></aside>
      ${noForm?'<aside><label>Browse category<select id="inline-navigation" name="browse_category" onchange="window.location.href=\'/archive?category=\'+this.value"><option value="">Select category</option><option value="video">Video Generator</option></select></label></aside>':''}
      <script>window.navigationChanges=0;window.productChanges=0;
        var dropdown=document.getElementById('wp-block-categories-1');
        function onCatChange(){window.navigationChanges++;if(dropdown.options[dropdown.selectedIndex].value>0){location.href='/archive?cat='+dropdown.options[dropdown.selectedIndex].value;}}
        dropdown.onchange=onCatChange;
        for(const id of ['product-category','product-pricing','product-type','discovery-category'])document.getElementById(id).addEventListener('change',()=>window.productChanges++);
      </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const browserContext=await browser.newContext({serviceWorkers:'block'});
  await browserContext.route('**/*',route=>{
    if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();
    externalRequests++;return route.abort();
  });
  const page=await browserContext.newPage();
  for(const path of ['/product-form','/no-form']){
    await page.goto(`http://127.0.0.1:${server.address().port}${path}`,{waitUntil:'load'});
    const engine=await attachEngine(browserContext,page.mainFrame(),async()=>({ok:true}));
    try{
      const result=await engine.call({action:'smartFill',config:{brandName:'Fixture Tool',targetDomain:'https://product.invalid/',tags:'Video Generator',pricing:'Paid',projectFields:{Name:'Fixture Tool',Url:'https://product.invalid/','PRICING TYPE':'Paid'}}});
      assert.notEqual(result.stale,true);
      const state=await page.evaluate(()=>({navigationChanges:window.navigationChanges,productChanges:window.productChanges,
        values:Object.fromEntries(Array.from(document.querySelectorAll('select')).map(element=>[element.id,element.value]))}));
      assert.equal(state.navigationChanges,0);
      assert.equal(state.values['wp-block-categories-1'],'-1');
      if(path==='/no-form')assert.equal(state.values['inline-navigation'],'');
      assert.equal(state.values['product-category'],'video');
      assert.equal(state.values['discovery-category'],'video');
      assert.equal(state.values['product-pricing'],'Paid');
      assert.equal(state.values['product-type'],'web');
      assert.equal(state.productChanges,4);
      assert.equal(navigations,0);
      assert.equal(new URL(page.url()).pathname,path);
      const report=await engine.call({action:'getFilledFieldsReport'});
      assert.ok(!report.fields.some(field=>['cat','browse_category'].includes(field.name)));
      t.diagnostic(JSON.stringify({fixture:path,navigations,externalRequests,posts,...state}));
    }catch(error){t.diagnostic(JSON.stringify({fixture:path,navigations,navigationPaths,pageUrl:page.url(),error:error.message}));throw error;}
    finally{await engine.detach();}
  }
  assert.equal(posts,0);assert.equal(externalRequests,0);
});
