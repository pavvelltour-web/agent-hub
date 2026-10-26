import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { AgentId } from '../core/types.ts';

/** Things only the local desktop can do for the panel: a folder dialog and a terminal window for signing in. Fixed commands, no user text in them. */

const PICK_PS = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description = 'Выберите папку проекта'; $d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog($f) -eq 'OK') { Write-Output $d.SelectedPath }",
].join('; ');

/** Native "choose folder" window on the machine running the hub. Returns the path, or null when the user cancelled. */
export function pickFolder(): { path: string | null } {
  let r;
  if (process.platform === 'win32') r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', PICK_PS], { encoding: 'utf8', timeout: 300_000, windowsHide: false });
  else if (process.platform === 'darwin') r = spawnSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Выберите папку проекта")'], { encoding: 'utf8', timeout: 300_000 });
  else r = spawnSync('zenity', ['--file-selection', '--directory', '--title=Выберите папку проекта'], { encoding: 'utf8', timeout: 300_000 });
  if (r.error) throw new Error('folder dialog is not available on this system: type the path instead');
  const p = (r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim();
  if (!p) return { path: null };
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('the chosen folder does not exist');
  return { path: p.replace(/[\\/]+$/, '') };
}

/** Open a terminal window running the agent's own sign-in. The hub never sees the password or token. */
export function openLogin(id: AgentId, exe: string): void {
  const args = id === 'claude' ? ['auth', 'login'] : ['login'];
  if (process.platform === 'win32') {
    if (/['"`$]/.test(exe)) throw new Error('unsafe program path');
    const list = args.map((a) => `'${a}'`).join(',');
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -ArgumentList ${list}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    if (/["\\]/.test(exe)) throw new Error('unsafe program path');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${exe} ${args.join(' ')}"`], { detached: true, stdio: 'ignore' }).unref();
  } else throw new Error(`open a terminal and run: ${id === 'claude' ? 'claude auth login' : 'codex login'}`);
}
