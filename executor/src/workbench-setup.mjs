import { randomBytes } from 'node:crypto';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './store.mjs';
import { Cloud } from './cloud.mjs';

// Initializes application-owned state only. Never reads browser credentials or replaces a paired device.
export async function initializeWorkbench({ home = process.env.EXTERNALLINK_HOME || join(homedir(), '.externallink-executor'), enrollment } = {}) {
  const file = join(home, 'outbox.sqlite');
  if (existsSync(file)) {
    const read = new Store(file, { readOnly: true });
    let pair;
    try { pair = read.get('pair'); } finally { read.close(); }
    if (pair) {
      if (enrollment && ['endpoint', 'workspaceId', 'deviceId'].some(key => enrollment[key] !== pair[key])) throw Error('本机已有配对，禁止替换设备或工作区');
      if (pair.storageBackend !== 'd1') throw Error('已有旧版配对，请保留数据并完成 D1 迁移；禁止覆盖旧台账');
      return { ok: true, initialized: false, deviceId: pair.deviceId, workspaceId: pair.workspaceId };
    }
  }
  const config = enrollment || JSON.parse(await readFile(join(home, 'enrollment.json'), 'utf8'));
  if (config.storageBackend !== 'd1' || !config.deviceId || !config.deviceToken || !config.workspaceId || !config.endpoint) throw Error('需要有效的 D1 设备登记文件');
  const snapshot = await new Cloud(config).request('snapshot');
  if (snapshot.deviceId !== config.deviceId || snapshot.workspaceId !== config.workspaceId) throw Error('云端设备范围不匹配，本机尚未写入配对');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const store = new Store(file);
  try {
    store.acquireOwner();
    if (store.get('pair') || store.pendingCount() || store.values('task:').length) throw Error('本机存在配对或历史任务，禁止初始化覆盖');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.set('pair', { endpoint: config.endpoint, workspaceId: config.workspaceId, deviceId: config.deviceId,
        deviceToken: config.deviceToken, storageBackend: 'd1', localToken: randomBytes(32).toString('base64url') });
      store.set('paused', true);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  } finally { store.close(); }
  if (process.platform !== 'win32') await chmod(file, 0o600);
  return { ok: true, initialized: true, deviceId: config.deviceId, workspaceId: config.workspaceId, profiles: Object.keys(snapshot.documents?.siteProfiles || {}).length };
}
