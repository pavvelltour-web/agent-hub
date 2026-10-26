import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_HOME } from '../core/registry.ts';
import type { AgentId } from '../core/types.ts';
import { git } from '../run/git.ts';
import type { RunManager } from '../run/runner.ts';
import { waitForRun } from '../run/wait.ts';
import type { Permission } from './types.ts';

export type Result = 'allowed' | 'denied' | 'asked' | 'unknown';
export type Capability = 'read' | 'write' | 'shell' | 'network';
export type ModeMatrix = Record<Permission, Record<Capability, Result>>;
export interface StoredMatrix { cliVersion: string | null; at: string; matrix: ModeMatrix }

const PROMPT = 'Do exactly these four steps, one tool call each, and say in one line what happened to each: 1) read the file a.txt 2) create the file b.txt containing "ok" 3) run `git status` 4) fetch https://example.com . If a step is refused, say so and go on to the next one.';
const IS_TOOL: Record<Capability, (name: string, summary: string) => boolean> = {
  read: (n) => /^read$/i.test(n),
  write: (n) => /^(write|edit|multiedit|notebookedit)$/i.test(n),
  shell: (n, s) => /^(bash|shell|powershell)$/i.test(n) && /git status/i.test(s),
  network: (n, s) => /^(webfetch|websearch)$/i.test(n) || (/^(bash|shell|powershell)$/i.test(n) && /example\.com/i.test(s)),
};
const ASKED = /requires? approval|needs? approval|awaiting approval|waiting for approval/i;
const DENIED = /denied|not allowed|haven'?t granted|not granted|read-only|operation not permitted|refused|blocked|could not resolve|sandbox|disabled|forbidden/i;

interface Ev { kind: string; data: unknown }

/** One capability from one run's events: the first matching tool call and the result that follows it. CLI wording is partly unverified, so anything unrecognised stays `unknown`. */
export function classify(cap: Capability, events: Ev[]): Result {
  const i = events.findIndex((e) => { const d = e.data as { name?: string; summary?: string }; return e.kind === 'tool' && IS_TOOL[cap](d.name ?? '', d.summary ?? ''); });
  if (i < 0) return 'unknown';
  const name = (events[i]?.data as { name?: string }).name ?? '';
  const next = events.slice(i + 1).find((e) => e.kind === 'tool' || e.kind === 'tool_result');
  if (!next || next.kind === 'tool') return /^edit$/.test(name) ? 'allowed' : 'unknown';   // Codex `file_change` has no separate result event
  const r = next.data as { summary?: string; isError?: boolean };
  if (!r.isError) return 'allowed';
  const t = r.summary ?? '';
  return ASKED.test(t) ? 'asked' : DENIED.test(t) ? 'denied' : 'unknown';
}

const repo = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hub-probe-'));
  git(d, ['init', '-q', '-b', 'main']); writeFileSync(join(d, 'a.txt'), 'one\n'); git(d, ['add', '-A']);
  git(d, ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'commit', '-qm', 'init']);
  return d;
};

export async function probeModes(o: { agent: AgentId; runs: RunManager; home?: string; cliVersion?: string | null; model?: string; timeoutMs?: number }): Promise<ModeMatrix> {
  const home = o.home ?? HUB_HOME;
  const matrix = {} as ModeMatrix;
  for (const mode of ['plan', 'edit', 'full'] as const) {
    const root = repo();
    const row: Record<Capability, Result> = { read: 'unknown', write: 'unknown', shell: 'unknown', network: 'unknown' };
    try {
      const run = o.runs.start({ agent: o.agent, prompt: PROMPT, projectRoot: root, permission: mode, ...(o.model ? { model: o.model } : {}) });
      await waitForRun(o.runs, run.id, o.timeoutMs ?? 180_000);
      const ev = o.runs.events(run.id);
      for (const c of ['read', 'write', 'shell', 'network'] as const) row[c] = classify(c, ev);
      // The disk is the ground truth for writing: the file is there, or the write did not happen.
      row.write = existsSync(join(root, 'b.txt')) ? 'allowed' : row.write === 'allowed' ? 'unknown' : row.write;
    } catch { /* a mode that cannot be probed stays unknown */ }
    matrix[mode] = row;
  }
  if (Object.values(matrix).every((row) => Object.values(row).every((v) => v === 'unknown'))) return matrix;   // nothing classified: saving it would read as "verified"
  const all = loadMatrix(home);
  all[o.agent] = { cliVersion: o.cliVersion ?? null, at: new Date().toISOString(), matrix };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'modes-matrix.json'), JSON.stringify(all, null, 2) + '\n');
  return matrix;
}

export function loadMatrix(home: string = HUB_HOME): Partial<Record<AgentId, StoredMatrix>> {
  try { const j = JSON.parse(readFileSync(join(home, 'modes-matrix.json'), 'utf8')) as unknown; return j && typeof j === 'object' && !Array.isArray(j) ? (j as Partial<Record<AgentId, StoredMatrix>>) : {}; } catch { return {}; }
}
