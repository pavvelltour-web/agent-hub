import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { redact } from '../lib/redact.ts';
import type { AgentAdapter, HubEvent, RunRequest } from './types.ts';

export interface RunHandle { done: Promise<{ code: number | null; events: number }>; stop: () => void; pid: number | undefined }

/** Kill the whole process tree (agents spawn shells and tools). */
function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
}

export interface StartOpts { env?: NodeJS.ProcessEnv; timeoutMs?: number; exe?: { cmd: string; prefix: string[] } }

/**
 * Start an agent without a shell: argument array only, prompt through stdin, stdout parsed as JSONL into HubEvents.
 * Always ends with exactly one `done` event, even if the process crashed or was stopped.
 */
export function startAgent(adapter: AgentAdapter, req: RunRequest, onEvent: (e: HubEvent) => void, opts: StartOpts = {}): RunHandle {
  const exe = opts.exe ?? adapter.exe();
  if (!exe) { onEvent({ kind: 'error', message: `${adapter.id} CLI not found on this PC` }); onEvent({ kind: 'done', ok: false }); return { done: Promise.resolve({ code: null, events: 2 }), stop: () => {}, pid: undefined }; }
  const child = spawn(exe.cmd, [...exe.prefix, ...adapter.args(req)], { cwd: req.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let events = 0, sawDone = false, stopped = false, sawProblem = false;
  const emit = (e: HubEvent): void => { events++; if (e.kind === 'done') { if (sawDone) return; sawDone = true; } if (e.kind === 'error' || (e.kind === 'limit' && e.reached)) sawProblem = true; onEvent(e); };
  child.stdin.on('error', () => { /* process exited before reading stdin */ });
  child.stdin.end(req.prompt);
  createInterface({ input: child.stdout }).on('line', (line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let obj: unknown;
    try { obj = JSON.parse(t); } catch { return; }
    for (const e of adapter.parse(obj)) emit(e);
  });
  let err = '';
  child.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString('utf8'); });
  const timer = opts.timeoutMs ? setTimeout(() => { emit({ kind: 'error', message: `timed out after ${opts.timeoutMs}ms` }); stop(); }, opts.timeoutMs) : undefined;
  function stop(): void { stopped = true; if (child.pid) killTree(child.pid); }
  const done = new Promise<{ code: number | null; events: number }>((resolve) => {
    child.on('error', (e) => { emit({ kind: 'error', message: `cannot start ${adapter.id}: ${e.message}` }); emit({ kind: 'done', ok: false }); resolve({ code: null, events }); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!sawDone) {
        if (stopped) emit({ kind: 'warn', message: 'stopped by user' });
        else if (code !== 0 && !sawProblem && err.trim()) emit({ kind: 'error', message: redact(err.trim().split('\n').filter((x) => !/^\d{4}-\d\d-\d\dT.*(ERROR|WARN)/.test(x)).slice(-3).join(' ').slice(0, 400)) || `exited with code ${code}` });
        emit({ kind: 'done', ok: code === 0 && !stopped });
      }
      resolve({ code, events });
    });
  });
  return { done, stop, pid: child.pid };
}
