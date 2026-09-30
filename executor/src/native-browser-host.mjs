// User signs in interactively first; the existing executor then attaches to
// this same dedicated Chrome directory. No authentication state is exported.
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
const login = JSON.parse((await readFile(path.join(root, 'manual-login.json'), 'utf8')).replace(/^\uFEFF/, ''));
const expectedProfile = path.join(root, 'browser-profile-stable');
if (path.resolve(login.profile).toLowerCase() !== path.resolve(expectedProfile).toLowerCase()) throw new Error('人工登录目录不属于此执行器');
const openUrl = process.env.EXTERNALLINK_OPEN_URL || 'http://127.0.0.1:19389/';
if (!['http:', 'https:'].includes(new URL(openUrl).protocol)) throw new Error('入口必须为 http/https 网站');
const started = Date.now();
const recordEvent=event=>appendFile(path.join(root,'host-events.jsonl'),JSON.stringify({at:new Date().toISOString(),hostPid:process.pid,...event})+'\n');
await recordEvent({type:'native_launch',openOrigin:new URL(openUrl).origin});
const chrome = spawn(login.executablePath, [
  `--user-data-dir=${login.profile}`, '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', '--disable-extensions', '--new-window', openUrl,
], { stdio: 'ignore', windowsHide: false });
let exitInfo;
chrome.on('error', error => { exitInfo = error.message;recordEvent({type:'native_launch_error',code:error.code}).catch(()=>{}); });
chrome.on('exit', (code, signal) => { exitInfo = `Chrome 退出 ${code ?? signal}`;recordEvent({type:'native_exit',chromePid:chrome.pid,code,signal}).catch(()=>{}); });
let endpoint, version;
for (let attempt = 0; attempt < 80; attempt++) {
  if (exitInfo) throw new Error(exitInfo);
  try {
    const portFile = path.join(login.profile, 'DevToolsActivePort');
    if ((await stat(portFile)).mtimeMs >= started) {
      const [port] = (await readFile(portFile, 'utf8')).trim().split('\n');
      if (!/^\d+$/.test(port)) throw new Error('调试端口无效');
      const candidate = `http://127.0.0.1:${port}`;
      const health = await fetch(candidate + '/json/version', { signal: AbortSignal.timeout(1000) });
      if (health.ok) { endpoint = candidate; version = (await health.json()).Browser; break; }
    }
  } catch {}
  await delay(250);
}
if (!endpoint) throw new Error('Chrome 原生启动连接未就绪，保留登录目录，不重建或清空');
const instance = { pid: process.pid, chromePid: chrome.pid, endpoint,
  executablePath: login.executablePath, version, profile: login.profile,
  mode: 'native-chrome', startedAt: new Date(started).toISOString() };
await writeFile(path.join(root, 'host.json'), JSON.stringify(instance));
await recordEvent({type:'native_connected',browserInstance:instance.startedAt,chromePid:chrome.pid});
await writeFile(path.join(root, 'host-config.json'), JSON.stringify({ mode: 'native-chrome' }));
console.log(JSON.stringify({ ok: true, mode: instance.mode, version, chromePid: chrome.pid }));
await new Promise(resolve => chrome.once('exit', resolve));
