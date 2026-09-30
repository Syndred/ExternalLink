export function aiOfDayCopy(profile) {
  const description=String(profile?.fields?.['Short Discription(100-150 words)']||'').trim();
  if(profile?.name!=='JevPlay'||profile?.url!=='https://jevplay.com'||!description||description.length>1500)throw new Error('站点文案缺少核实资料或超过1500字符');
  return {description,tagline:'Free AI tools for chat intent analysis and decision support',features:[
    'Analyze up to ten short messages for likely intent, reply timing, conversation risk and next actions.',
    'See intent probabilities and confidence instead of a single unexplained answer.',
    'Draft and rank possible replies when a compatible text model is configured; messages are never sent automatically.',
    'Explore interactive decisions with Code Breaker, Word Ladder, Dungeon Crawler and Snake Challenge.',
    'Use the public preview without an account, with server-checked actions, live comparisons and replayable results.'
  ]};
}
