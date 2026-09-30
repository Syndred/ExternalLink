export async function fillAndVerifyText(locator,value){
 value=String(value??'');if(await locator.inputValue()===value)return;
 await locator.fill(value,{timeout:5000});
 if(await locator.inputValue()!==value){
  await locator.evaluate((element,text)=>{
   if(!['INPUT','TEXTAREA'].includes(element.tagName)||element.disabled||element.readOnly)throw new Error('文本控件已变化');
   const win=element.ownerDocument.defaultView,proto=element.tagName==='TEXTAREA'?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;
   const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('文本控件缺少原生赋值器');
   setter.call(element,text);element.dispatchEvent(new win.Event('input',{bubbles:true}));element.dispatchEvent(new win.Event('change',{bubbles:true}));
  },value);
 }
 if(await locator.inputValue()!==value)throw new Error('文本字段没有保持核实值；未提交');
}
