import test from 'node:test';import assert from 'node:assert/strict';
import{encodeBase64,decodePngEvidence}from'../cloud/worker/src/executor-binary.mjs';
test('binary transport preserves all bytes and typed-array slices at screenshot scale',()=>{
 const all=new Uint8Array(1024*1024+12);for(let i=0;i<all.length;i++)all[i]=i%256;
 const slice=all.subarray(7,all.length-3),encoded=encodeBase64(slice);
 assert.deepEqual(new Uint8Array(decodePngEvidence('data:image/png;base64,'+encoded)),slice);
});
test('evidence decoding enforces format, canonical base64 and the existing 3 MB limit',()=>{
 const bytes=new Uint8Array(3*1024*1024);assert.equal(decodePngEvidence('data:image/png;base64,'+encodeBase64(bytes)).length,bytes.length);
 for(const input of ['data:text/plain;base64,AA==','data:image/png;base64,@@AA==','data:image/png;base64,',
  'data:image/png;base64,'+encodeBase64(new Uint8Array(bytes.length+1))])assert.throws(()=>decodePngEvidence(input));
});
