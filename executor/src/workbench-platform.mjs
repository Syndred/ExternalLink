import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function watchdogAddress(platform, home) {
  const id = createHash('sha256').update(home).digest('hex').slice(0, 16);
  return platform === 'win32' ? '\\\\.\\pipe\\externallink-watch-' + id : '/tmp/externallink-watch-' + id + '.sock';
}

export function browserLaunch(platform, url, env = process.env) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: ['-a', 'Google Chrome', url] };
  if (platform !== 'win32') throw Error('当前启动入口支持 Windows 和 macOS');
  const chrome = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    .map(p => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(existsSync);
  if (!chrome) throw Error('未找到 Chrome');
  return { command: chrome, args: ['--new-window', url] };
}
