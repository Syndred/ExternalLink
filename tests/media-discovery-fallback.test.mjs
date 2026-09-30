import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discoverMedia} from '../skills/external-link-operator/scripts/discover-media.mjs';

test('a missing local product checkout retains verified deployed profile media URLs',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'el-media-fallback-'));
  try {
    const libraryPath=join(temp,'library.json'),rootsPath=join(temp,'roots.json');
    await writeFile(libraryPath,JSON.stringify({projects:{Product:{LOGO:'https://product.test/logo.png','Featured image':'https://product.test/hero.png','Screenshot 1':'https://product.test/screen.png'}}}));
    await writeFile(rootsPath,JSON.stringify({Product:join(temp,'missing')}));
    const result=await discoverMedia({profile:'Product',libraryPath,rootsPath});
    for(const [role,url]of [['logo','logo.png'],['featured','hero.png'],['screenshot','screen.png']]){
      assert.equal(result[role][0].sourceUrl,'https://product.test/'+url);
      assert.equal(result[role][0].path,'');
      assert.equal(result[role][0].source,'profile-field-remote');
    }
  } finally {await rm(temp,{recursive:true,force:true});}
});
