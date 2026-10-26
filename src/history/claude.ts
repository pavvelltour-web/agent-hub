import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../lib/jsonl.ts';
import { redact } from '../lib/redact.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { count, safe, text as capText } from '../adapters/event-utils.ts';
import type { HubEvent } from '../adapters/types.ts';
import { pageEvents, type EventPage } from './events.ts';
import { addMessage, addUsage, getState, resetSession, setState, tx, upsertSession, type Db } from './store.ts';

const MAX_TEXT = 20_000;
const clip = (s: string, n = MAX_TEXT): string => (s.length > n ? s.slice(0, n) + '…' : s);

interface Block { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
interface Line {
  type?: string; sessionId?: string; cwd?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; summary?: string;
  message?: { role?: string; model?: string; content?: string | Block[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
}

/** Short, redacted description of a tool call for the transcript (never the full input). */
const toolSummary = (b: Block): string => {
  const i = b.input ?? {};
  const v = i['command'] ?? i['file_path'] ?? i['path'] ?? i['pattern'] ?? i['url'] ?? i['description'] ?? i;
  return clip(redact(typeof v === 'string' ? v : JSON.stringify(v) ?? ''), 400);     // never String(v): `{toString:1}` throws
};

const isNoise = (t: string): boolean => /^<(system-reminder|command-|local-command|task-notification|ide_|user-prompt)/.test(t.trimStart()) || t.startsWith('Caveat:');

export interface SyncStats { files: number; changed: number; sessions: number; messages: number }

/** Import `~/.claude/projects/**.jsonl` incrementally (by byte offset). Read-only on the source. */
export async function syncClaude(db: Db, claudeDir = join(homedir(), '.claude')): Promise<SyncStats> {
  const stats: SyncStats = { files: 0, changed: 0, sessions: 0, messages: 0 };
  const root = join(claudeDir, 'projects');
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return stats; }
  const seen = new Set<string>();
  for (const d of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const path = join(root, d, f);
      const st = statSync(path);
      stats.files++;
      const prev = getState(db, path);
      if (prev && prev.size === st.size && prev.mtimeMs === Math.floor(st.mtimeMs)) continue;
      stats.changed++;
      let offset = prev && st.size >= prev.byteOffset ? prev.byteOffset : 0;
      let ordinal = offset === 0 ? 0 : prev?.lastOrdinal ?? 0;
      if (offset === 0 && prev) resetSession(db, `claude:${f.replace('.jsonl', '')}`);
      const nativeId = f.replace('.jsonl', '');
      const id = `claude:${nativeId}`;
      let title: string | null = null, model: string | null = null, cwd: string | null = null, first: string | null = null, last: string | null = null;
      const rows: { role: string; ts: string | null; text: string; tool?: string }[] = [];
      const usage: { ts: string | null; model: string | null; u: { uncachedIn: number; cachedIn: number; out: number } }[] = [];
      for await (const { obj, endByte } of readJsonl(path, offset)) {
        offset = endByte;
        const l = obj as Line;
        if (l.cwd && !cwd) cwd = l.cwd;
        if (l.timestamp) { first ??= l.timestamp; last = l.timestamp; }
        if (l.type === 'summary' && l.summary) title = l.summary;
        const m = l.message;
        if (!m || l.isMeta) continue;
        if (l.type === 'assistant') {
          if (m.model && !m.model.startsWith('<')) model = m.model;
          const u = m.usage;
          if (u) usage.push({ ts: l.timestamp ?? null, model: m.model && !m.model.startsWith('<') ? m.model : null, u: { uncachedIn: count(u.input_tokens) + count(u.cache_creation_input_tokens), cachedIn: count(u.cache_read_input_tokens), out: count(u.output_tokens) } });
          if (l.isSidechain || !Array.isArray(m.content)) continue;
          const text = m.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
          if (text) rows.push({ role: 'assistant', ts: l.timestamp ?? null, text: clip(redact(text)) });
          for (const b of m.content) if (b.type === 'tool_use' && b.name) rows.push({ role: 'tool', ts: l.timestamp ?? null, text: toolSummary(b), tool: capText(b.name, 200) || 'unknown' });
        } else if (l.type === 'user' && !l.isSidechain) {
          const text = (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')).trim();
          if (!text || isNoise(text)) continue;
          title ??= clip(text.replace(/\s+/g, ' '), 90);
          rows.push({ role: 'user', ts: l.timestamp ?? null, text: clip(redact(text)) });
        }
      }
      tx(db, () => {
        upsertSession(db, { id, agent: 'claude', nativeId, cwd, title: title ? redact(title) : null, model, startedAt: first, endedAt: last, sourceKind: 'claude-jsonl', sourcePath: path, origin: 'cli' });
        for (const r of rows) addMessage(db, id, ordinal++, r.role, r.ts, r.text, r.tool ?? null);
        for (const u of usage) addUsage(db, id, u.ts, u.model, u.u);
        setState(db, path, { size: st.size, mtimeMs: Math.floor(st.mtimeMs), byteOffset: offset, lastOrdinal: ordinal });
      });
      stats.messages += rows.length;
      seen.add(id);
    }
  }
  stats.sessions = seen.size;
  return stats;
}

/** Lines that only describe the file itself (snapshots, titles, queue, request blobs...): never shown, never `unknown`. */
const BOOKKEEPING = /^(summary|system|attachment|mode|permission-mode|last-prompt|custom-title|ai-title|agent-name|tag|pr-link|cost-state|progress|worktree|file-history|queue-|bridge-|atis-|api-request|history-)/;

/**
 * One recorded line of `~/.claude/projects/**.jsonl` as hub events. Assistant and tool_result lines have the same shape as the live
 * stream-json, so the live parser does the mapping (one source of truth); only the person's own messages are new here.
 */
export function historyLineEvents(line: unknown): HubEvent[] {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
  const l = line as Line;
  if (typeof l.type !== 'string') return [{ kind: 'unknown', type: '(none)' }];
  if (BOOKKEEPING.test(l.type)) return [];
  if (l.isSidechain || l.isMeta) return [];
  if (l.type === 'assistant') return claudeAdapter.parse(line);
  if (l.type === 'user') {
    const c = l.message?.content;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n') : '').trim();
    return [...(text && !isNoise(text) ? [{ kind: 'user', text: safe(text) } as HubEvent] : []), ...claudeAdapter.parse(line)];
  }
  return [{ kind: 'unknown', type: l.type.slice(0, 60) }];
}

/** Events of one Claude conversation file, read from `offset` (see `pageEvents` for the position format). Read-only, streamed. */
export const readSessionEvents = (sourcePath: string, o: { offset: number; limit: number }): Promise<EventPage> => pageEvents(sourcePath, o, historyLineEvents);
