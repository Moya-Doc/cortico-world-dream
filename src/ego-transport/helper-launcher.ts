/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const shellString = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const nativeArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
export async function prepareHelperLauncher(dir: string, cliFile: string, platform: NodeJS.Platform = process.platform): Promise<{ launcherFile: string; helperDir: string }> {
  const helperDir = resolve(dir);
  if (/[\u0000-\u001f]/.test(cliFile) || /[\u0000-\u001f]/.test(helperDir)) throw new Error('Invalid helper path.');
  await mkdir(helperDir, { recursive: true, mode: 0o700 });
  const bundle = fileURLToPath(new URL('../../dist/ego-helper.mjs', import.meta.url));
  if (platform === 'win32') {
    const args = [bundle, '--dir', helperDir, '--cli', cliFile || 'ego-browser'].map(value => psString(nativeArg(value))).join(', ');
    const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\ntry {\n` +
      `  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n` +
      `  $principal = New-Object Security.Principal.WindowsPrincipal($identity)\n` +
      `  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Start this launcher from File Explorer without administrator privileges.' }\n` +
      `  $nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source\n` +
      `  Start-Process -FilePath $nodeExe -ArgumentList @(${args}) -WindowStyle Hidden -RedirectStandardOutput ${psString(join(helperDir, 'helper.stdout.log'))} -RedirectStandardError ${psString(join(helperDir, 'helper.stderr.log'))}\n` +
      `} catch { Write-Host $_.Exception.Message; exit 1 }\n`;
    const launcherFile = join(helperDir, 'start-ego-helper.cmd');
    await writeFile(join(helperDir, 'start-ego-helper.ps1'), script, { mode: 0o600 });
    await writeFile(launcherFile, `@echo off\r\npowershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}\r\nif errorlevel 1 pause\r\n`, { encoding: 'ascii', mode: 0o600 });
    return { launcherFile, helperDir };
  }
  const launcherFile = join(helperDir, platform === 'darwin' ? 'start-ego-helper.command' : 'start-ego-helper.sh');
  const args = [bundle, '--dir', helperDir, '--cli', cliFile || 'ego-browser'].map(shellString).join(' ');
  const script = `#!/bin/sh\nset -eu\numask 077\nif [ "$(id -u)" = 0 ]; then echo 'Start this launcher from a terminal without root privileges.'; exit 1; fi\nPATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nexport PATH\nnode_path=$(command -v node) || { echo 'Install Node.js 22 or later, then restart this launcher.'; exit 1; }\nnohup "$node_path" ${args} >${shellString(join(helperDir, 'helper.stdout.log'))} 2>${shellString(join(helperDir, 'helper.stderr.log'))} </dev/null &\nprintf '%s\\n' 'Ego helper started. Reconnect in the Dream extension.'\n`;
  await writeFile(launcherFile, script, { mode: 0o700 });
  await chmod(launcherFile, 0o700);
  return { launcherFile, helperDir };
}
