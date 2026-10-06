import test from 'node:test';
import assert from 'node:assert/strict';
import '../core/profiles.js';
const P = globalThis.ExtLinkProfiles;

test('AI draft uses the original merge rules while preserving its product identity and empty original lists', () => {
  const submitted = { id: 'p', name: 'Original', fields: { Name: 'Original' }, useCases: ['original use'], logoDataUrl: 'original bytes' };
  const result = P.mergeProfileEditorDraft(submitted, structuredClone(submitted), { id: 'other', fields: { Name: 'Generated' }, useCases: [], language: 'zh', promoUrl: 'https://promo.example' });
  assert.equal(result.id, 'p'); assert.equal(result.name, 'Generated'); assert.deepEqual(result.useCases, ['original use']);
  assert.equal(result.logoDataUrl, 'original bytes'); assert.equal(result.language, 'zh'); assert.equal(result.promoUrl, 'https://promo.example');
});

test('typing while AI is pending preserves changed fields, notes, rules, zero and explicit empty values', () => {
  const submitted = { id: 'p', fields: { Name: 'Original', Title: 'Original title', Note: 'Old note' }, fieldNotes: { Name: 'old note' }, anchorRules: { allowExactMatch: true }, blogRules: { maxLinksPerDraft: 2 } };
  const current = structuredClone(submitted); current.fields.Name = 'Typed after request'; current.fields.Note = ''; current.fieldNotes.Name = 'New note'; current.anchorRules.allowExactMatch = false; current.blogRules.maxLinksPerDraft = 0;
  const result = P.mergeProfileEditorDraft(submitted, current, { fields: { Name: 'AI name', Title: 'AI title', Note: 'AI note' }, fieldNotes: { Name: 'AI note' }, anchorRules: { allowExactMatch: true, brandKeywords: ['AI brand'] }, blogRules: { maxLinksPerDraft: 4, tone: 'professional' } });
  assert.equal(result.fields.Name, 'Typed after request'); assert.equal(result.fields.Title, 'AI title'); assert.equal(result.fields.Note, '');
  assert.equal(result.fieldNotes.Name, 'New note'); assert.equal(result.anchorRules.allowExactMatch, false); assert.deepEqual(result.anchorRules.brandKeywords, ['AI brand']);
  assert.equal(result.blogRules.maxLinksPerDraft, 0); assert.equal(result.blogRules.tone, 'professional');
});

test('a changed list and homepage during AI remain current while unchanged generated content is adopted', () => {
  const submitted = { id: 'p', name: 'Old', url: 'https://old.example', fields: { Name: 'Old', Url: 'https://old.example' }, useCases: ['old'], media: { logo: 'cloud-media://old', screenshots: ['old'] } };
  const current = structuredClone(submitted); current.name = 'Typed'; current.fields.Name = 'Typed'; current.url = ''; current.fields.Url = ''; current.useCases = []; current.media.screenshots = ['typed'];
  const result = P.mergeProfileEditorDraft(submitted, current, { fields: { Name: 'Generated', Url: 'https://generated.example', Title: 'New title' }, useCases: ['generated'], media: { screenshots: ['generated'] } });
  assert.equal(result.name, 'Typed'); assert.equal(result.url, ''); assert.equal(result.fields.Url, ''); assert.deepEqual(result.useCases, []);
  assert.equal(result.fields.Title, 'New title'); assert.deepEqual(result.media.screenshots, ['typed']); assert.equal(result.media.logo, 'cloud-media://old');
});

test('new user input keys added while AI is pending remain in the draft without changing the submitted data', () => {
  const submitted = { id: 'p', fields: { Name: 'Original' } }, before = structuredClone(submitted);
  const current = { ...submitted, fields: { ...submitted.fields, Custom: 'new input' }, fieldNotes: { Custom: 'new note' } };
  const result = P.mergeProfileEditorDraft(submitted, current, { fields: { Name: 'AI', Custom: 'AI custom' } });
  assert.equal(result.fields.Custom, 'new input'); assert.equal(result.fieldNotes.Custom, 'new note'); assert.deepEqual(submitted, before);
});
