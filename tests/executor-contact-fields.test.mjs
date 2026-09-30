import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('personal and company fields require explicit profile facts', () => {
  const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const start = content.indexOf('  function resolveContactIdentityValue(');
  const end = content.indexOf('  function resolveValueForField(', start);
  assert.ok(start >= 0 && end > start);
  const context = { fitValueToConstraints: value => value };
  vm.createContext(context);
  vm.runInContext(content.slice(start, end), context);
  const resolve = (config, pf, hint) => context.resolveContactIdentityValue(config, pf, hint, {});
  const product = { brandName: 'JevPlay', username: 'JevPlay' };
  assert.equal(resolve(product, { Name: 'JevPlay', Note: 'Free daily games' }, 'First Name*'), '');
  assert.equal(resolve(product, { Note: 'Free daily games' }, 'Phone*'), '');
  assert.equal(resolve(product, { Name: 'JevPlay' }, 'Company Name*'), '');
  assert.equal(resolve(product, { Name: 'JevPlay' }, 'Your Name*'), '');
  assert.equal(resolve({ brandName: 'JevPlay', username: 'Syndred' }, {}, 'First Name*'), '');
  assert.equal(resolve({ brandName: 'JevPlay', username: 'Syndred' }, {}, 'Submitter Email*'), null);
  assert.equal(resolve(product, { Name: 'JevPlay' }, '请输入昵称'), '');
  assert.equal(resolve(product, { 'Contact person': 'Syndred Young' }, 'First Name*'), 'Syndred');
  assert.equal(resolve(product, { 'Contact person': 'Syndred Young' }, 'Your Name*'), 'Syndred Young');
  assert.equal(resolve(product, { 'Contact person': 'Syndred Young' }, 'Last Name*'), 'Young');
  assert.equal(resolve(product, { Phone: '+1 212 555 0123' }, 'Phone*'), '+1 212 555 0123');
  assert.equal(resolve(product, { Phone: 'Free daily games' }, 'Phone*'), '');
  assert.equal(resolve(product, {}, 'Product Description'), null);
});
