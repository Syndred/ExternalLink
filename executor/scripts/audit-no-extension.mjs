import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Cloud } from '../src/cloud.mjs';
import { inventory, plain } from '../src/shared.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
const db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true});
const get=id=>JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get(id)?.value||'null');
const output=join(homedir(),'.externallink-backups','audit-no-extension-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output,{recursive:true});
try {
  const snapshot=await new Cloud(get('pair')).request('snapshot');
  const serialized=JSON.stringify(snapshot,null,2);
  await writeFile(join(output,'snapshot.json'),serialized,{flag:'wx'});
  const docs=snapshot.documents, products=Object.entries(docs.siteProfiles||{}).map(([id,p])=>({id,name:p.name||p.fields?.Name,url:p.url||p.fields?.Url,
    fieldNames:Object.keys(p.fields||{}),media:p.media||p.fields?.media||null,
    sha256:createHash('sha256').update(JSON.stringify(p)).digest('hex')}));
  const library=plain(inventory(snapshot,null));
  const summary={at:new Date().toISOString(),output,snapshotSha256:createHash('sha256').update(serialized).digest('hex'),revisions:snapshot.revisions,
    products,documents:Object.entries(docs).map(([id,v])=>({id,bytes:Buffer.byteLength(JSON.stringify(v)),count:Array.isArray(v)?v.length:typeof v==='object'&&v?Object.keys(v).length:null})),
    library:{total:library.total,sources:library.sources},
    tasks:db.prepare("SELECT count(*) AS n FROM state WHERE id LIKE 'task:%'").get().n,
    runs:db.prepare("SELECT count(*) AS n FROM state WHERE id LIKE 'run:%'").get().n};
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
  console.log(JSON.stringify(summary));
}finally{db.close();}
