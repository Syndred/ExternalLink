import {fillAndVerifyText} from '../text-input.mjs';
import {selectCommittedMenuOption} from '../menu-picker.mjs';
export function classifyNavToolsGate({submitDisabled,responsePresent,frameUrls=[]}) {
 if(!submitDisabled||responsePresent||!frameUrls.some(value=>{try{const u=new URL(value);return u.hostname==='challenges.cloudflare.com'&&u.pathname.includes('turnstile');}catch{return false;}}))return null;
 return {attentionType:'human_verification',reason:'NavTools 免费 Basic 投稿资料已齐全并通过字段校验，Turnstile 尚未完成且 Submit AI Tool 仍被站方禁用；保留原页，未点击投稿'};
}
export const navToolsAdapter={
 key:'navtools-manual-basic',matches(url){const u=new URL(url);return u.hostname.replace(/^www\./,'')==='navtools.ai'&&/^\/submit\/?$/.test(u.pathname);},
 async prepare(page){
      const categories = page.getByRole('button',{name:'Search and select categories',exact:true});
      if(await categories.count()===1&&await categories.getAttribute('aria-expanded')==='true')await page.keyboard.press('Escape');
      const free = page.locator('label[for="free"]');
      const radio = page.locator('button#free[role="radio"]');
      if (await free.count() === 1 && await radio.count() === 1 && await radio.getAttribute('aria-checked') !== 'true') {
        await radio.press('Space');
        await page.waitForFunction(() => document.querySelector('button#free[role="radio"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 3000 })
          .catch(() => { throw new Error('免费 Basic 方案未被页面确认，停止投稿'); });
      }
      const manual = page.locator('label[for="content-manual"]');
      const manualRadio = page.locator('button#content-manual[role="radio"]');
      if (await manual.count() === 1 && await manualRadio.count() === 1 && await manualRadio.getAttribute('aria-checked') !== 'true') {
        await manualRadio.press('Space');
        await page.waitForFunction(() => document.querySelector('button#content-manual[role="radio"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 3000 })
          .catch(() => { throw new Error('手动内容方案未被页面确认，停止投稿'); });
      }

 },
 async fill(frame,profile,task,runtime){
      if(profile.name!=='JevPlay'||profile.url!=='https://jevplay.com')throw new Error('NavTools 当前核实文案仅适用于 JevPlay，其他产品需要自己的适配资料');
      const values={toolName:profile.name,websiteUrl:profile.url,email:profile.fields['Business mail'],
        shortDescription:profile.fields['Short description(20-30 words)'],description:profile.fields['Short Discription(100-150 words)'],
        'features.0.text':'Analyze up to ten short messages for likely intent, reply timing, conversation risk and recommended next actions, with visible probability distributions.',
        'useCases.0.text':'Understand conversation intent and compare structured decisions using free browser tools.',
        howToUse:'Open JevPlay and choose Chat Intent Analyzer. Enter up to ten short messages and review the likely intent, probability distribution and suggested next actions. Explore the interactive decision tools to compare human and AI choices and replay results.',
        'faqs.0.question':'Is JevPlay free to use?',
        'faqs.0.answer':'Yes. JevPlay offers free browser tools for conversation analysis and interactive decision exploration.',
        officialEmail:profile.fields['Business mail'],discordUrl:'',productHuntUrl:''};
      for(const [name,value]of Object.entries(values))await fillAndVerifyText(frame.locator('input[name="'+name+'"],textarea[name="'+name+'"]'),value);
      const pricing=await selectCommittedMenuOption(frame,'#pricingModel','Free');
      runtime.update(task,{selectedPickers:{...(task.selectedPickers||{}),pricing}},'verified_picker_values');
      const body=await frame.evaluate(()=>document.body.innerText);
      if(/Categories\s*\*\s*0\/10 selected/.test(body)){
        const categories=frame.getByRole('button',{name:'Search and select categories',exact:true});
        if(await categories.count()!==1)throw new Error('NavTools 分类入口未唯一核实');
        if(await categories.getAttribute('aria-expanded')!=='true')await categories.click({timeout:5000});
        const option=frame.getByRole('option',{name:'AI Productivity Tools',exact:true});
        if(await option.count()!==1)throw new Error('NavTools 缺少已核实的 AI Productivity Tools 分类');
        await option.click({timeout:5000});await frame.page().keyboard.press('Escape');
        const selected=await frame.evaluate(()=>document.body.innerText.match(/Categories\s*\*([\s\S]*?)Pricing Model/)?.[1]||'');
        if(!/1\/10 selected/.test(selected)||!selected.includes('AI Productivity Tools'))throw new Error('NavTools 分类未保持');
        runtime.update(task,{selectedPickers:{...(task.selectedPickers||{}),category:'AI Productivity Tools'}},'verified_picker_values');
      }

 },
 async gate(page,context){
  const submit=page.getByRole('button',{name:'Submit AI Tool',exact:true});if(await submit.count()!==1)return null;
  const responsePresent=await page.evaluate(()=>[...document.querySelectorAll('[name="cf-turnstile-response"]')].some(e=>Boolean(e.value?.trim())));
  const frameUrls=page.frames().map(f=>f.url());
  if(context&&frameUrls.some(u=>!u)&&/^https:\/\/navtools\.ai\/submit\/?$/.test(page.url())){
   const session=await context.newCDPSession(page);
   try{const {frameTree}=await session.send('Page.getFrameTree');
    if(frameTree.frame.url!==page.url())throw new Error('NavTools 当前目标身份已变化，停止验证码核验');
    const visit=node=>{frameUrls.push(node.frame.url);for(const child of node.childFrames||[])visit(child);};visit(frameTree);
   }finally{await session.detach();}
  }
  return classifyNavToolsGate({submitDisabled:!await submit.isEnabled(),responsePresent,frameUrls});
 }
};
