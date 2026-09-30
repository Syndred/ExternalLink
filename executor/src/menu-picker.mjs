export async function selectCommittedMenuOption(frame,selector,label){
 const control=frame.locator(selector);if(await control.count()!==1)throw new Error('选择控件未唯一核实');
 if((await control.innerText()).trim()===label)return label;
 if(await control.getAttribute('data-state')!=='open')await control.click({timeout:5000});
 const option=frame.getByRole('option',{name:label,exact:true});if(await option.count()!==1)throw new Error('菜单缺少唯一核实选项');
 await option.click({timeout:5000});if((await control.innerText()).trim()!==label)throw new Error('选项未保存');return label;
}
