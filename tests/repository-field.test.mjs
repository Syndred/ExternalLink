import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('extension/content.js', 'utf8');
const start = source.indexOf('  function resolveValueForField(');
const end = source.indexOf('  async function fillSelectField(', start);
const helperStart = source.indexOf('  function isEmailFieldHint(');
const helperEnd = source.indexOf('  function getProfileFields(', helperStart);
const context = {
  URL,
  getFieldConstraints: () => ({}),
  fitValueToConstraints: value => String(value || ''),
  pickDescriptionForField: () => '',
  getProfileFields: config => config.projectFields || {},
  getFieldHint: element => element.hint,
  getSnapshotLabel: element => element.hint,
};
vm.createContext(context);
const identityStart = source.indexOf('  function gameSubmissionFieldKind(');
assert.ok(identityStart >= 0 && identityStart < start);
vm.runInContext(`${source.slice(helperStart, helperEnd)}\n${source.slice(identityStart, end)}`, context);
const field = { hint: 'github url optional', type: 'url', tagName: 'INPUT' };
assert.equal(context.resolveValueForField({ targetDomain: 'https://product.example' }, field), '');
assert.equal(context.resolveValueForField({ projectFields: { GitHub: 'https://product.example' } }, field), '', 'previously mislearned homepage must not be replayed');
assert.equal(context.resolveValueForField({ projectFields: { 'GitHub URL': 'https://github.com/team/product' } }, field), 'https://github.com/team/product');
console.log('repository URL field tests passed');
