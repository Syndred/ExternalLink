import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('  function findSubmitButton('), source.indexOf('  function findSafeAdvanceButton('));
function choose(buttons, scope) {
  const document = { querySelectorAll(selector) { return selector === '[role="button"]' ? [] : buttons.filter(b => !selector.includes('type="submit"') || selector.startsWith('button,') || b.type === 'submit'); } };
  const context = vm.createContext({ document, Node: {}, getActiveFillScope: () => scope || document,
    isAiGenerationGoogleForm: () => false, queryFillableElements: () => [], isVisible: () => true,
    getElementLabel: b => b.innerText.toLowerCase(), isMarketingOptInForm: () => false, hasLikelySubmissionFields: () => false });
  vm.runInContext(functionSource, context);
  return context.findSubmitButton('button[type="submit"]', ['submit', 'add', 'list', 'send']);
}
const button = (label, options = {}) => ({ tagName: 'BUTTON', type: 'submit', innerText: label,
  getAttribute: () => null, closest: () => null, ...options });

test('disabled review action never falls through to account logout', () => {
  assert.equal(choose([button('Sign out'), button('Submit for review', { disabled: true })]), null);
  assert.equal(choose([button('Log out'), button('Submit for review', { disabled: true })]), null);
});
test('enabled review action is selected while account actions are excluded', () => {
  const review = button('Submit for review');
  assert.equal(choose([review, button('Sign out')]), review);
});
test('logout form action is excluded even when its button lacks an action label', () => {
  assert.equal(choose([button('Continue', { form: { getAttribute: key => key === 'action' ? '/auth/logout' : null } })]), null);
});
test('bookmark action is not a directory submission', () => {
  assert.equal(choose([button('Save tool')]), null);
});

test('plan selection is an intermediate action even when rendered as submit',()=>{
 assert.equal(choose([button('Select Plan >>')]),null);
});
test('preview and metadata intake are never final submission actions',()=>{
 for (const label of ['Preview my product','Preview listing','Save draft','Fetch product data','Import website','Scrape page','Next','Continue','Proceed']) {
  assert.equal(choose([button(label)]),null,label);
 }
 const final=button('Submit for review');
 assert.equal(choose([button('Preview my product'),final]),final);
});
test('an explicitly scoped submission never uses another form action', () => {
  const scope = { matches: () => true, contains: () => false };
  const review = button('Submit', { form: scope });
  assert.equal(choose([button('Submit', { form: {} }), review], scope), review);
});
