import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkbench } from '../executor/src/workbench-setup.mjs';
import { browserLaunch, watchdogAddress } from '../executor/src/workbench-platform.mjs';
import { Store } from '../executor/src/store.mjs';

test('Mac opens the normal workbench through Chrome and uses a bounded Unix socket', () => {
  assert.deepEqual(browserLaunch('darwin', 'http://127.0.0.1:19389/#access=test'), {
    command: '/usr/bin/open', args: ['-a', 'Google Chrome', 'http://127.0.0.1:19389/#access=test'],
  });
  const socket = watchdogAddress('darwin', '/Users/example/' + 'long'.repeat(100));
  assert.ok(socket.endsWith('.sock'));
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.notEqual(socket, watchdogAddress('darwin', '/Users/other'));
  assert.ok(watchdogAddress('win32', 'C:/app').startsWith('\\\\.\\pipe\\'));
});

test('new workbench validates D1 device before persisting, stays paused and preserves an existing pair', async () => {
  const home = await mkdtemp(join(tmpdir(), 'el-setup-'));
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer test-device');
    assert.equal(req.url, '/v2/executor/snapshot?workspace=default');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, deviceId: 'new-mac', workspaceId: 'default',
      documents: { siteProfiles: { JevPlay: { id: 'JevPlay', fields: { Url: 'https://jevplay.com' } } } }, revisions: { siteProfiles: 3 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const file = join(home, 'enrollment.json');
  await writeFile(file, JSON.stringify({ endpoint, workspaceId: 'default', deviceId: 'new-mac', deviceToken: 'test-device', storageBackend: 'd1' }));
  try {
    await assert.rejects(initializeWorkbench({ home, enrollment: { endpoint, workspaceId: 'default', deviceId: 'wrong', deviceToken: 'test-device', storageBackend: 'd1' } }), /范围不匹配/);
    const result = await initializeWorkbench({ home });
    assert.equal(result.initialized, true);
    assert.equal(result.profiles, 1);
    assert.equal(JSON.stringify(result).includes('test-device'), false);
    const store = new Store(join(home, 'outbox.sqlite'));
    const pair = store.get('pair');
    assert.equal(store.get('paused'), true);
    assert.equal(pair.storageBackend, 'd1');
    assert.ok(pair.localToken.length >= 40);
    store.set('protected', { note: 'existing state' }); store.close();
    const second = await initializeWorkbench({ home });
    assert.equal(second.initialized, false);
    assert.equal(calls, 2);
    const read = new Store(join(home, 'outbox.sqlite'), { readOnly: true });
    assert.deepEqual(read.get('pair'), pair);
    assert.deepEqual(read.get('protected'), { note: 'existing state' }); read.close();
    await assert.rejects(initializeWorkbench({ home, enrollment: { endpoint, workspaceId: 'other', deviceId: 'other', deviceToken: 'other', storageBackend: 'd1' } }), /已有配对/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true }); }
});
