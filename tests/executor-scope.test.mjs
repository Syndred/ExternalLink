import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScope, priorProductSuccess } from '../executor/src/shared.mjs';

test('historical success on a different submit path excludes the same product and host', () => {
  const snapshot = { documents: {
    sheetTableData: { entries: [{ link: 'https://www.example.com/submit-new' }, { link: 'https://other.example/submit' }] },
    urlList: '', siteAnnotations: {}, domainBlacklist: [], deletedSubmissionKeys: [],
    submissionRecords: {
      'example.com/old-submit::JevPlay': { status: 'success', destinationUrl: 'https://example.com/old-submit', profileId: 'JevPlay' },
      'other.example/previous::Different': { status: 'success', destinationUrl: 'https://other.example/previous', profileId: 'Different' },
    },
  } };
  const scope = selectScope(snapshot, null, 'JevPlay');
  assert.equal(scope.tasks.map(x => x.destinationKey).join(','), 'other.example/submit');
  assert.match(scope.exclusions[0].reason, /已有成功提交/);
  assert.equal(priorProductSuccess(snapshot.documents.submissionRecords, 'JevPlay', 'https://www.example.com/submit-new'), true);
  assert.equal(priorProductSuccess(snapshot.documents.submissionRecords, 'JevPlay', 'https://other.example/submit'), false);
});
