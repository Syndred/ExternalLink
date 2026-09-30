import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('Chinese category placeholder is empty and JevPlay maps only to a fitting option', () => {
  const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const start = content.indexOf('  function getNativeSelectOptions(');
  const end = content.indexOf('  function queryCustomDropdowns(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    getFieldHint: () => '产品分类 category',
    getProfileFields: config => config.projectFields,
    normalizeOptionText: value => String(value || '').toLowerCase().trim(),
  };
  vm.createContext(context);
  vm.runInContext(content.slice(start, end), context);
  const config = { brandName: 'JevPlay', projectFields: { Name: 'JevPlay', 'Tags Keywords/Hashtags': 'AI games, decision games' } };
  const option = (value, label) => ({ value, textContent: label, label, disabled: false });
  const select = options => ({ tagName: 'SELECT', value: options[0].value, options, selectedOptions: [options[0]] });
  assert.equal(context.isSelectEmpty(select([option('0', '选择分类')])), true);
  assert.equal(context.resolveSelectValueForField(select([option('0', '选择分类'), option('fun', '实用有趣'), option('writing', 'AI写作神器')]), config), 'fun');
  assert.equal(context.resolveSelectValueForField(select([option('0', '选择分类'), option('writing', 'AI写作神器')]), config), '');
  const tools = { ...config, projectFields: { Name: 'JevPlay', 'Tags Keywords/Hashtags': 'chat intent analysis, decision support, AI games' } };
  assert.equal(context.resolveSelectValueForField(select([option('', 'Select a category'), option('Productivity', 'Productivity'), option('writing', 'Writing & Content')]), tools), 'Productivity');
  assert.equal(context.resolveSelectValueForField(select([option('', 'Select a category'), option('developer', 'Coding & Dev Tools')]), tools), '');
});
