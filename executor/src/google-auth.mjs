export async function findGooglePopup(context, original) {
  const matches=[];
  for(const page of context.pages()) {
    if(page.isClosed() || page===original || !/^https:\/\/accounts\.google\.com\//.test(page.url()))continue;
    if(await page.opener()===original)matches.push(page);
  }
  if(matches.length!==1)throw new Error('没有唯一属于原任务的 Google 登录弹窗');
  return matches[0];
}
