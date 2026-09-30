// First-install alternative for a machine without the plugin's cloud session.
// Requires the operator's existing Cloudflare login. The one-time credential
// can only create one scoped device; it cannot access any state or admin route.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repo } from './shared.mjs';
const endpoint = process.argv[2], workspaceId = process.argv[3] || 'default';
if (!endpoint || new URL(endpoint).protocol !== 'https:') throw new Error('用法：node src/enroll-device.mjs https://正式Worker域名 [workspace]');
const home = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
await mkdir(home, { recursive: true, mode: 0o700 });
try {
  const existing = JSON.parse(await readFile(path.join(home, 'enrollment.json'), 'utf8'));
  if (existing.deviceToken) throw Error('本机已有设备登记文件，请先运行 setup-workbench.mjs；不会替换原设备');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = `ele_${randomBytes(32).toString('hex')}`;
const enrollment = { hash: createHash('sha256').update(token).digest('hex'), workspaceId, expiresAt: Date.now() + 10 * 60 * 1000 };
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(repo, 'cloud/worker/node_modules/wrangler/bin/wrangler.js'), 'secret','put','EXECUTOR_ENROLLMENT'], { cwd: path.join(repo, 'cloud/worker'), windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, CI: 'true' } });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  child.stdin.end(JSON.stringify(enrollment));
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Cloudflare 设备登记失败：${output}`)));
});
const response = await fetch(`${endpoint.replace(/\/$/,'')}/v2/executor/devices?workspace=${encodeURIComponent(workspaceId)}`, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: os.hostname() }) });
const data = await response.json();
if (!response.ok) throw new Error(data.error || `登记失败 HTTP ${response.status}`);
if (data.storageBackend !== 'd1' || data.workspaceId !== workspaceId || !data.deviceId || !data.deviceToken) throw Error('设备登记返回范围不匹配，未保存凭据');
await writeFile(path.join(home, 'enrollment.json'), JSON.stringify({ endpoint, workspaceId, deviceId: data.deviceId, deviceToken: data.deviceToken, storageBackend: 'd1' }), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ ok: true, deviceId: data.deviceId, workspaceId, next: 'node scripts/setup-workbench.mjs，然后打开工作台' }));
