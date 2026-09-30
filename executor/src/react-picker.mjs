// React Select keeps the committed value outside its tiny search input.
export async function selectVerifiedOption(frame,selector,choices,readCommitted) {
  const input=frame.locator(selector);
  if(await input.count()!==1)throw new Error('分类控件不唯一，停止选择');
  const selected=readCommitted||(()=>input.evaluate(e=>e.closest('[class$="-container"]')?.textContent || e.parentElement?.parentElement?.parentElement?.textContent || ''));
  const before=await selected();
  const existing=choices.find(x=>before.split(',').map(x=>x.trim()).includes(x));if(existing)return existing;
  await input.focus();await input.press('ArrowDown');
  if(!/^#[\w-]+$/.test(selector))throw new Error('React选择器缺少核实ID');
  const id=selector.slice(1),prefix=id.startsWith('react-select-')?id.replace(/-input$/,''):'react-select-'+id;
  const group=frame.locator(`[id^="${prefix}-option-"]:visible`);
  await group.first().waitFor({state:'visible',timeout:3000}).catch(()=>{});
  const options=(await group.allTextContents()).map(x=>x.trim());
  const chosen=choices.find(x=>options.includes(x));
  if(!chosen)throw new Error(`${selector} 缺少核实选项；可用选项：${options.join(', ').slice(0,1800)}`);
  const option=group.filter({hasText:new RegExp('^'+chosen.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});
  if(await option.count()!==1)throw new Error('分类选项不唯一，停止选择');
  await option.click({timeout:5000});
  if(!(await selected()).includes(chosen))throw new Error('选择没有被页面保存；未提交');
  return chosen;
}
