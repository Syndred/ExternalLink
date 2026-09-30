import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSubmissionQuality } from '../executor/src/quality.mjs';

test('a WordPress search text input cannot impersonate the product website identity',()=>{
 const profile={name:'JevPlay',fields:{Url:'https://jevplay.com'}};
 const report={fields:[{name:'s',type:'text',label:'Search This Website Search',value:'https://jevplay.com'}]};
 assert.ok(assessSubmissionQuality(report,profile).some(i=>/站内搜索控件/.test(i)));
 assert.ok(assessSubmissionQuality(report,profile).some(i=>/没有核实/.test(i)));
 assert.deepEqual(assessSubmissionQuality({fields:[{name:'website',type:'url',label:'AI Tool Website',value:'https://jevplay.com'}]},profile),[]);
 assert.ok(assessSubmissionQuality({fields:[...report.fields,{label:'AI Tool Name',value:'JevPlay'}]},profile).some(i=>/站内搜索控件/.test(i)));
});

test('observed Chinese form mismatch stops before the submit boundary', () => {
  const profile = { name: 'JevPlay', fields: { Name: 'JevPlay', Url: 'https://jevplay.com' } };
  const fields = [
    { label: '产品名称', type: 'text', value: 'Play free daily decision games' },
    { label: '产品分类', type: 'select-one', value: '0' },
    { label: '填写标签', type: 'textarea', value: 'JevPlay is an independent browser playground. '.repeat(16) },
    { label: 'Website URL', type: 'url', value: 'https://jevplay.com' },
  ];
  const issues = assessSubmissionQuality({ fields }, profile);
  assert.equal(issues.length, 3);
  assert.match(issues.join(' '), /产品名称与资料品牌不一致/);
  assert.match(issues.join(' '), /分类仍是占位项/);
  assert.match(issues.join(' '), /标签字段疑似被填入长文案/);
  assert.deepEqual(assessSubmissionQuality({ fields: [
    { label: '产品名称', type: 'text', value: 'JevPlay' },
    { label: '产品分类', type: 'select-one', value: '实用有趣' },
    { label: '填写标签', type: 'textarea', value: 'AI games, decision games' },
  ] }, profile), []);
  assert.match(assessSubmissionQuality({ fields: [
    { label: 'Tool name', type: 'textarea', value: 'JevPlay is an independent browser playground for daily games.' },
  ] }, profile).join(' '), /产品名称与资料品牌不一致/);
  assert.match(assessSubmissionQuality({ fields: [] }, profile).join(' '), /禁止提交搜索框或空表单/);
});
