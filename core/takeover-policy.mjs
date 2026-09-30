const protectedAction=/captcha|turnstile|recaptcha|otp|password|验证码|密码|purchase|checkout|billing|payment|subscribe|delete|remove account|授权|同意.*条款|terms|privacy|agreement/i;
const finalAction=/submit|publish|launch|send|create(?:\s+\w+)?\s+(?:account|listing|product)|提交|发布|发送/i;
export function restrictPreparationActions(actions,snapshot,limit=4) {
  if(!/^https?:\/\//.test(snapshot?.url||''))return[];
  const fields=new Map((snapshot.fields||[]).map(f=>[f.selector,f]));
  const controls=new Map([...(snapshot.buttons||[]),...(snapshot.widgets||[])].map(f=>[f.selector,f]));
  return (Array.isArray(actions)?actions:[]).filter(action=>{
    if(action.type==='wait')return Number(action.timeout_ms||0)>=0&&Number(action.timeout_ms||0)<=3000;
    const element=fields.get(action.selector)||controls.get(action.selector);
    if(!element||element.disabled||element.visible===false&&!(action.type==='upload'&&element.type==='file'))return false;
    const label=[element.label,element.text,element.aria,element.name,element.type,element.href].filter(Boolean).join(' ');
    if(protectedAction.test(label))return false;
    if(['fill','select','check'].includes(action.type))return fields.has(action.selector)&&element.type!=='file'&&typeof action.value!=='object';
    if(action.type==='upload')return fields.has(action.selector)&&element.type==='file'&&/^(?:logo|featured|screenshot(?:[1-4])?)$/.test(action.mediaKind||'');
    if(action.type==='click') {
      const caption=String(element.text||element.label||'').trim().replace(/^(.+?)\s+\1$/i,'$1');
      if(element.type==='submit'||finalAction.test([caption,element.aria,element.label].filter(Boolean).join(' ')))return false;
      // Unknown buttons cannot silently submit. Intermediate navigation and
      // observed dropdown controls/options may be used before the final boundary.
      return /^(?:next|continue|back|continue with free|continue for free|下一步|继续|返回)(?:\s*[→›»]+)?$/i.test(caption)||
        ['listbox','menu'].includes(element.popup)||
        ['combobox','listbox','option','menuitem','tab'].includes(element.role);
    }
    return false;
  }).slice(0,limit);
}
