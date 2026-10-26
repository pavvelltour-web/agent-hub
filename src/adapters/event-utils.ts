import { redact } from '../lib/redact.ts';
import { clip, MAX_BODY, type HubEvent } from './types.ts';

/** Redact first, then cap: a secret cut by the limit must never leave a recognisable prefix behind. */
export const safe = (s: string): string => { const r = redact(s); return r.length > MAX_BODY ? r.slice(0, MAX_BODY) : r; };

/** Redact every string inside a tool input (values only), cap each one, keep numbers/booleans. Depth-limited. */
export function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return safe(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 8) return '[…]';
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
}

export const asInput = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (redactDeep(v) as Record<string, unknown>) : {});

export const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

/** A tool output as the model/CLI printed it: short `summary` for lists, `body` capped after redaction, real `lines`. */
export function resultEvent(id: string, raw: string, isError: boolean): Extract<HubEvent, { kind: 'tool_result' }> {
  const red = redact(raw);
  return { kind: 'tool_result', id, summary: clip(red, 300), body: red.length > MAX_BODY ? red.slice(0, MAX_BODY) : red, lines: lineCount(raw), truncated: red.length > MAX_BODY, ...(isError ? { isError: true } : {}) };
}

export const thinkingEvent = (raw: string): Extract<HubEvent, { kind: 'thinking' }> => ({ kind: 'thinking', text: safe(raw), tokens: Math.ceil(raw.length / 4) });

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/** Line diff of one replacement: common leading/trailing lines are not counted. `hunks` is a small unified-style text. */
export function replaceDiff(oldS: string, newS: string): { added: number; removed: number; hunks: string } {
  const a = splitLines(oldS), b = splitLines(newS);
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const rem = a.slice(p, a.length - s), add = b.slice(p, b.length - s);
  return { added: add.length, removed: rem.length, hunks: `@@ -${p + 1},${rem.length} +${p + 1},${add.length} @@\n${[...rem.map((l) => '-' + l), ...add.map((l) => '+' + l)].join('\n')}` };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `Edit` / `MultiEdit` tool input → one diff event (sums all edits). Undefined for anything else or a malformed input. */
export function editDiff(name: string, input: Record<string, unknown> | undefined): Extract<HubEvent, { kind: 'diff' }> | undefined {
  if (!input || (name !== 'Edit' && name !== 'MultiEdit')) return undefined;
  const path = str(input['file_path']);
  if (!path) return undefined;
  const edits = name === 'Edit' ? [input] : Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : [];
  let added = 0, removed = 0; const hunks: string[] = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>, d = replaceDiff(str(o['old_string']), str(o['new_string']));
    added += d.added; removed += d.removed; hunks.push(d.hunks);
  }
  return { kind: 'diff', path: safe(path), added, removed, hunks: safe(hunks.join('\n')) };
}
