// Documents are already immutable validated JSON objects. Reuse their bytes without
// decoding, parsing and serializing the full workspace on every device refresh.
export async function deviceSnapshotResponse(store,deviceId){
 const rows=(await store.db.prepare('SELECT * FROM documents WHERE workspace=? ORDER BY key').bind(store.workspace).all()).results,revisions=Object.fromEntries(rows.map(r=>[r.key,r.revision])),objects=[];
 for(const row of rows)objects.push(await store.readObjectBytes(row.object_key,row.checksum));
 const encoder=new TextEncoder(),prefix=encoder.encode('{"ok":true,"deviceId":'+JSON.stringify(deviceId)+',"workspaceId":'+JSON.stringify(store.workspace)+',"revisions":'+JSON.stringify(revisions)+',"documents":{');
 const body=new ReadableStream({start(controller){controller.enqueue(prefix);for(let i=0;i<rows.length;i++){controller.enqueue(encoder.encode((i?',':'')+JSON.stringify(rows[i].key)+':'));controller.enqueue(objects[i]);}controller.enqueue(encoder.encode('}}'));controller.close();}});
 return new Response(body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
