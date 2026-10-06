import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const repo = fileURLToPath(new URL('../../', import.meta.url));
const sandbox = { self: {}, URL, crypto: globalThis.crypto };
vm.createContext(sandbox);
for (const name of ['profiles','queue','target-filters','scheduler','submission-timeline','url-library','library-classifier','opportunity-score','executor-contract']) {
  vm.runInContext(readFileSync(path.join(repo, `core/${name}.js`), 'utf8'), sandbox);
}
export const queue = sandbox.self.ExtLinkQueue;
export const profiles = sandbox.self.ExtLinkProfiles;
export const timeline = sandbox.self.ExtLinkSubmissionTimeline;
export const classifier = sandbox.self.ExtLinkLibraryClassifier;
export const scheduler = sandbox.self.ExtLinkScheduler;
export const opportunity = sandbox.self.ExtLinkOpportunityScore;
export const builtinUrls = sandbox.self.ExtLinkUrlLibrary || sandbox.self.BUILTIN_URLS;
export const plain = value => JSON.parse(JSON.stringify(value));

export const inventory = sandbox.self.ExtLinkExecutorContract.inventory;
export const selectScope = sandbox.self.ExtLinkExecutorContract.selectScope;
export const priorProductSuccess = sandbox.self.ExtLinkExecutorContract.priorProductSuccess;
