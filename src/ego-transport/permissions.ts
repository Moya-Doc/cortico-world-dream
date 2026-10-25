/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import { execFile } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import { promisify } from 'node:util';

export function minimalEnvironment(file = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: [file ? dirname(file) : '', dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].filter(Boolean).join(delimiter) };
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true, env: minimalEnvironment(), timeout: 3000, maxBuffer: 128 * 1024 });
    return /S-1-16-(12288|16384|20480)\b/.test(stdout);
  }
  return process.getuid?.() === 0;
}
