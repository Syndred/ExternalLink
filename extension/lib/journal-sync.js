(function(global){
  'use strict';
  function create({storage,request,config}){
    let serial=Promise.resolve();
    const identity=c=>String(c.endpoint||'')+'|'+String(c.workspaceId||'default');
    const locked=fn=>{const work=serial.then(fn,fn);serial=work.catch(()=>{});return work;};
    async function flush(){
      const current=await config(),scope=identity(current);
      let queue=(await storage.get('d1JournalPending')).d1JournalPending||[];
      let error='';
      for(const item of queue.filter(item=>item.scope===scope).slice(0,10)){
        try{
          if(identity(await config())!==scope)throw new Error('工作区已切换');
          await request('/v2/timeline',{method:'POST',body:{event:item.event}},current);
          const proof=await request('/v2/state/submissionTimeline',{},current);
          const saved=Object.values(proof.data||{}).flat().find(e=>e.id===item.event.id);
          if(!saved||JSON.stringify(saved)!==JSON.stringify(item.event))throw new Error('进度回读不一致');
          queue=queue.filter(e=>!(e.scope===scope&&e.event.id===item.event.id));
          await storage.set({d1JournalPending:queue});
        }catch(e){error=e.message;break;}
      }
      return{ok:true,pending:queue.filter(e=>e.scope===scope).length,error};
    }
    return{
      enqueue:event=>locked(async()=>{const scope=identity(await config());const queue=(await storage.get('d1JournalPending')).d1JournalPending||[];
        if(!queue.some(e=>e.scope===scope&&e.event.id===event.id)){queue.push({scope,event});await storage.set({d1JournalPending:queue});}
        return flush();}),
      flush:()=>locked(flush),
    };
  }
  global.ExtLinkJournalSync={create};
})(globalThis);
