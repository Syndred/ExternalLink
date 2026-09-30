(function(global){
  'use strict';
  const text=v=>String(v??'');
  function domain(value){try{return new URL(/^https?:/.test(value)?value:'https://'+value).hostname.toLowerCase().replace(/^www\./,'');}catch{return text(value);}}
  function build({tasks=[],records={},timeline={},historicalRecords={}}={}){
    const groups=new Map();
    function group(profileId,url){if(!profileId||!url)return null;const host=domain(url),key=profileId+'::'+host;if(!groups.has(key))groups.set(key,{key,profileId,host,url,tasks:[],records:[],events:[]});return groups.get(key);}
    for(const task of tasks)group(task.profileId,task.url||task.destinationKey)?.tasks.push(task);
    for(const [key,record] of Object.entries(records)){const [destinationKey,profileId]=key.split('::');group(record.profileId||profileId,record.destinationUrl||record.destinationKey||destinationKey)?.records.push(record);}
    for(const [key,record]of Object.entries(historicalRecords)){const [destinationKey,profileId]=key.split('::'),row=group(record.profileId||profileId,record.destinationUrl||record.destinationKey||destinationKey);if(row)(row.history??=[]).push(record);}
    for(const [key,events] of Object.entries(timeline.groups||timeline)){if(!Array.isArray(events))continue;const [destinationKey,profileId]=key.split('::');for(const event of events)group(event.profileId||profileId,event.destinationUrl||event.destinationKey||destinationKey)?.events.push(event);}
    return [...groups.values()].map(row=>{
      row.events.sort((a,b)=>text(a.occurredAt||a.at).localeCompare(text(b.occurredAt||b.at)));
      const success=row.records.some(r=>r.status==='success');
      row.submission=row.tasks.some(t=>t.siteStatus==='accepted')?'received':success?'historical_receipt':row.tasks.some(t=>t.siteStatus==='sent_unconfirmed'||t.status==='submitted_unconfirmed')?'unknown':row.tasks.some(t=>t.siteStatus==='rejected')?'rejected':row.tasks.some(t=>t.status==='needs_manual')?'not_submitted':'pending';
      if(row.history?.length&&!row.tasks.length&&!row.records.length)row.submission='historical_unverified';
      else if(!row.tasks.length&&!row.records.length)row.submission='unknown';
      const evidence=[...row.records,...row.tasks.map(t=>({...t.receipt,occurredAt:t.attemptBoundary})),...row.events].sort((a,b)=>text(a.occurredAt||a.submittedAt).localeCompare(text(b.occurredAt||b.submittedAt)));
      const siteEvents=evidence.filter(e=>['pending_moderation','published','rejected'].includes(e.publicationStatus||e.type));
      row.moderation=siteEvents.at(-1)?.publicationStatus||siteEvents.at(-1)?.type||'unknown';
      const linkEvents=evidence.filter(e=>['published','link_verified','link_missing','link_unreachable'].includes(e.publicationStatus||e.type));
      const lastLink=linkEvents.at(-1);const linkType=lastLink?.publicationStatus||lastLink?.type;
      row.validity=linkType==='link_missing'?'link_missing':linkType==='link_unreachable'?'unreachable':linkType==='link_verified'?'verified':linkType==='published'?'reported_published':'unverified';
      row.publicUrl=[...evidence].reverse().find(e=>e.publicUrl)?.publicUrl||'';
      row.checkedAt=lastLink?.occurredAt||lastLink?.submittedAt||'';
      row.reply=row.events.some(e=>e.type==='email_reply')?'received':'unknown';
      row.pendingEvents=row.tasks.reduce((n,t)=>n+Number(t.pendingEvents||0),0)+row.events.filter(e=>e._pending).length;
      row.sync=row.pendingEvents?'pending':row.tasks.length&&row.tasks.every(t=>t.source==='cloud')?'cloud':'unverified';
      return row;
    }).sort((a,b)=>a.profileId.localeCompare(b.profileId)||a.host.localeCompare(b.host));
  }
  global.ExtLinkSubmissionJournal={build,domain};
})(globalThis);
