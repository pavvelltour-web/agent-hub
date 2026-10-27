import { redact } from '../lib/redact.ts';
import { clip, MAX_BODY, type HubEvent } from './types.ts';

/** Redact first, then cap: a secret cut by the limit must never leave a recognisable prefix behind. */
export const safe = (s: string): string => { const r = redact(s); return r.length > MAX_BODY ? r.slice(0, MAX_BODY) : r; };

/** Redact every string inside a tool input (values only), cap each one, keep numbers/booleans. Depth-limited. */
export function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return safe(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 8) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => redactDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 200).map(([k, x]) => [k.slice(0, 100), redactDeep(x, depth + 1)]));
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

/** A string from untrusted data, redacted and capped; anything else becomes `fallback` (never String(x): `{toString:1}` throws). */
export const text = (v: unknown, n: number, fallback = ''): string => (typeof v === 'string' ? safe(v).slice(0, n) : fallback);
/** A token count / duration from untrusted data: finite and non-negative, else 0. */
export const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const s0 = (v: unknown): string => (typeof v === 'string' ? v : '');
const optCount = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
/** A token count from untrusted data: a finite, non-negative whole number, capped so sums and JSON stay exact. */
const TOKEN_CAP = 1e12;
const big = (v: unknown): number => Math.min(Math.floor(count(v)), TOKEN_CAP);
const TODO_STATES = new Set(['pending', 'active', 'done']);

/**
 * Last line of defence before an event is stored or sent to the panel: CLI output and history files are untrusted. Every field is rebuilt
 * from its expected type: strings stay strings (capped), numbers are finite (the runner sums them), booleans are real booleans, lists are
 * bounded. A kind outside the HubEvent union becomes `unknown`. Nothing here can throw on a hostile value.
 */
export function sanitizeEvent(raw: HubEvent): HubEvent {
  const e = raw as unknown as Record<string, unknown>;
  switch (e['kind']) {
    case 'session': { const model = text(e['model'], 200); return { kind: 'session', nativeId: text(e['nativeId'], 200), ...(model ? { model } : {}) }; }
    case 'user': case 'text': case 'partial': return { kind: e['kind'], text: s0(e['text']) } as HubEvent;
    case 'thinking': { const tokens = optCount(e['tokens']); return { kind: 'thinking', text: s0(e['text']), ...(tokens !== undefined ? { tokens } : {}) }; }
    case 'tool': { const input = e['input']; return { kind: 'tool', id: text(e['id'], 200), name: text(e['name'], 200) || 'unknown', summary: s0(e['summary']), input: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {} }; }
    case 'tool_result': return { kind: 'tool_result', id: text(e['id'], 200), summary: s0(e['summary']), body: s0(e['body']), lines: Math.floor(count(e['lines'])), truncated: e['truncated'] === true, ...(e['isError'] === true ? { isError: true } : {}) };
    case 'diff': return { kind: 'diff', path: text(e['path'], 4096), added: Math.floor(count(e['added'])), removed: Math.floor(count(e['removed'])), hunks: s0(e['hunks']) };
    case 'todo': {
      const items = Array.isArray(e['items']) ? (e['items'] as unknown[]).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !Array.isArray(i)).slice(0, 200) : [];
      return { kind: 'todo', items: items.map((i) => ({ text: text(i['text'], 2000), state: typeof i['state'] === 'string' && TODO_STATES.has(i['state']) ? (i['state'] as 'pending' | 'active' | 'done') : 'pending' })) };
    }
    case 'usage': {
      const reasoning = optCount(e['reasoning']), ms = optCount(e['ms']), cost = e['costUsd'];
      return { kind: 'usage', uncachedIn: count(e['uncachedIn']), cachedIn: count(e['cachedIn']), out: count(e['out']), ...(reasoning !== undefined ? { reasoning } : {}), ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}), ...(ms !== undefined ? { ms } : {}) };
    }
    case 'context': {
      const part = (k: string): { [x: string]: number } => (e[k] === undefined ? {} : { [k]: big(e[k]) }), mid = text(e['mid'], 120);
      return { kind: 'context', tokens: big(e['tokens']), ...part('newIn'), ...part('cachedIn'), ...part('out'), ...(mid ? { mid } : {}) };
    }
    case 'turn': {
      const reasoning = optCount(e['reasoning']), mid = text(e['mid'], 120);
      return { kind: 'turn', newIn: big(e['newIn']), cachedIn: big(e['cachedIn']), out: big(e['out']), ...(reasoning !== undefined ? { reasoning: Math.min(Math.floor(reasoning), TOKEN_CAP) } : {}), context: big(e['context']), ...(mid ? { mid } : {}) };
    }
    case 'unknown': return { kind: 'unknown', type: text(e['type'], 60, '(none)') };
    case 'limit': {
      const p = e['usedPercent'], r = e['resetsAt'], wm = e['windowMinutes'];
      return { kind: 'limit', reached: e['reached'] === true, message: text(e['message'], 2000), ...(typeof r === 'string' && r.length <= 64 && Number.isFinite(Date.parse(r)) ? { resetsAt: r } : {}), ...(typeof p === 'number' && Number.isFinite(p) ? { usedPercent: p } : {}), ...(typeof wm === 'number' && Number.isInteger(wm) && wm > 0 && wm <= 525_600 ? { windowMinutes: wm } : {}) };
    }
    case 'warn': return { kind: 'warn', message: text(e['message'], 2000) };
    case 'error': return { kind: 'error', message: text(e['message'], 2000), ...(e['needsLogin'] === true ? { needsLogin: true } : {}) };
    case 'done': return { kind: 'done', ok: e['ok'] === true };
    default: return { kind: 'unknown', type: text(e['kind'], 60, '(none)') };
  }
}

/** Window length of a Claude `rate_limit_event` (`rateLimitType`). NOT verified live (the CLI here is not signed in): an unknown or missing type gives no length, and a reading with no length is never used as weekly. */
export function claudeWindowMinutes(type: unknown): number | undefined {
  if (type === 'five_hour') return 300;
  if (typeof type === 'string' && /^seven_day(_[a-z]+)?$/.test(type)) return 10080;
  return undefined;
}
