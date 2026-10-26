import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentId } from '../core/types.ts';

export interface AgentInfo { installed: boolean; path?: string; version?: string }

const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];

function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const x of exts) { const p = join(dir, name + x); if (existsSync(p) && statSync(p).isFile()) return p; }
  }
  return undefined;
}

/** `claude.cmd` is an npm shim; spawn the real `claude.exe` it points to (spawning .cmd without a shell is refused). */
function resolveShim(p: string): string {
  if (!p.toLowerCase().endsWith('.cmd')) return p;
  const m = /"%dp0%\\([^"]+\.exe)"/i.exec(readFileSync(p, 'utf8'));
  const exe = m?.[1] ? resolve(dirname(p), m[1]) : undefined;
  return exe && existsSync(exe) ? exe : p;
}

function codexFromAppData(): string | undefined {
  const base = join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (!existsSync(base)) return undefined;
  const found = readdirSync(base).map((d) => join(base, d, 'codex.exe')).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}

export function locate(id: AgentId): AgentInfo {
  // Codex: the desktop app ships a real codex.exe; an npm `codex.cmd` shim cannot be spawned without a shell, so prefer the exe.
  const raw = id === 'claude' ? onPath('claude') : codexFromAppData() ?? onPath('codex');
  if (!raw) return { installed: false };
  const path = resolveShim(raw);
  if (path.toLowerCase().endsWith('.cmd')) return { installed: true };   // found, but not runnable by the hub without a shell
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const version = r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined;
  return { installed: true, path, ...(version ? { version } : {}) };
}

export const detectAgents = (): Record<AgentId, AgentInfo> => ({ claude: locate('claude'), codex: locate('codex') });
