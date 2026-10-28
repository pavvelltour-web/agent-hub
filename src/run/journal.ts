import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { change } from '../core/plan.ts';
import type { Plan } from '../core/types.ts';
import { isSafeName } from '../lib/paths.ts';
import { redact } from '../lib/redact.ts';

/**
 * The step journal (ADR-027): an append-only record of what each run did and why, kept in the hub's data folder. The hub never writes it into a project on its own:
 * `planJournalWrite` returns a plan for `specs/<task>/steps.md` that the person approves like any other write (backup and undo apply).
 */
export type JournalKind = 'start' | 'spawn' | 'verify' | 'review' | 'handoff' | 'end';
export interface JournalEntry { at: string; kind: JournalKind; runId: string; agent: string; model: string | null; goal: string; outcome?: string }

export const JOURNAL_MAX_BYTES = 1_000_000;
const KINDS = new Set<string>(['start', 'spawn', 'verify', 'review', 'handoff', 'end']);
const MARKER = '{"kind":"truncated"}\n';

const names = (project: string, task: string): void => { if (!isSafeName(project) || !isSafeName(task)) throw new Error('bad journal name: use letters, digits, dot, dash, underscore'); };
const fileOf = (home: string, project: string, task: string): string => join(home, 'journal', project, `${task}.jsonl`);
const line = (v: unknown, n: number): string => { const t = redact(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The last `n` bytes of a file as text (the marker check must not read a whole megabyte for every dropped entry). */
function tail(file: string, n: number): string {
  const fd = openSync(file, 'r');
  try { const size = fstatSync(fd).size, len = Math.min(n, size), b = Buffer.alloc(len); readSync(fd, b, 0, len, size - len); return b.toString('utf8'); } finally { closeSync(fd); }
}

/** Appends one step. An entry with an unknown kind or a time that is not a date is not recorded. At 1 MB one marker line is written and the journal stops growing. */
export function appendStep(home: string, project: string, task: string, entry: JournalEntry, maxBytes: number = JOURNAL_MAX_BYTES): void {
  names(project, task);
  if (!KINDS.has(entry.kind) || !Number.isFinite(Date.parse(entry.at))) return;
  const file = fileOf(home, project, task);
  let size = 0;
  try { size = statSync(file).size; } catch { /* a new journal */ }
  if (size >= maxBytes) { if (!tail(file, MARKER.length).endsWith(MARKER)) appendFileSync(file, MARKER); return; }
  mkdirSync(join(home, 'journal', project), { recursive: true });
  const clean: JournalEntry = { at: new Date(entry.at).toISOString(), kind: entry.kind, runId: line(entry.runId, 80), agent: line(entry.agent, 40), model: entry.model ? line(entry.model, 100) : null, goal: line(entry.goal, 300), ...(entry.outcome ? { outcome: line(entry.outcome, 60) } : {}) };
  appendFileSync(file, JSON.stringify(clean) + '\n');
}

/** The first `max` entries (the marker is not one) and whether there was more. */
export function readJournal(home: string, project: string, task: string, max = 2000): { entries: JournalEntry[]; truncated: boolean } {
  names(project, task);
  const file = fileOf(home, project, task);
  if (!existsSync(file)) return { entries: [], truncated: false };
  const entries: JournalEntry[] = [];
  let truncated = false;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try {
      const v = JSON.parse(l) as Omit<JournalEntry, 'kind'> & { kind: string };
      if (v.kind === 'truncated') { truncated = true; continue; }
      if (!KINDS.has(v.kind)) continue;
      if (entries.length >= max) { truncated = true; break; }
      entries.push(v as JournalEntry);
    } catch { /* a half-written line is skipped */ }
  }
  return { entries, truncated };
}

/** Deterministic Markdown: one line per step. */
export function renderSteps(entries: JournalEntry[]): string {
  if (!entries.length) return '# Steps\n\nNo steps recorded yet.\n';
  const rows = entries.map((x) => `- ${x.at} ${x.kind}${x.outcome ? `, ${x.outcome}` : ''}: ${x.agent}${x.model ? ` ${x.model}` : ''} (run ${x.runId}): ${x.goal}`);
  return ['# Steps', '', ...rows, ''].join('\n');
}

/** A plan that writes `specs/<task>/steps.md` in the project and nothing else. Pure: the caller shows it and applies it only after approval. */
export function planJournalWrite(root: string, task: string, entries: JournalEntry[]): Plan {
  if (!isSafeName(task)) throw new Error('bad journal name: use letters, digits, dot, dash, underscore');
  return { root, changes: [change(join(root, 'specs', task, 'steps.md'), renderSteps(entries), 'step journal of this task')], notes: ['Writes the hub\'s record of each step into specs/. Nothing else changes.'] };
}
