// Recover a read across a navigation; never replay the preceding mutation.
export async function readAfterNavigation(page,read) {
 for(let attempt=0;attempt<4;attempt++) {
  try{return await read();}
  catch(error){
   if(attempt===3||!/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message))throw error;
   await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});
   await page.waitForTimeout(250);
  }
 }
}
export async function settleObservedClick(page,before) {
 await page.waitForFunction(previous=>location.href+'|'+(document.body?.innerText||'')!==previous,before,{timeout:8000}).catch(()=>{});
 await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});
 await page.locator('input:visible,textarea:visible,select:visible,a[href]:visible,button:visible,[role=option]:visible').first().waitFor({state:'visible',timeout:10000}).catch(()=>{});
}
