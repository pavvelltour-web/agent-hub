import { redact } from '../lib/redact.ts';
import { locate } from './locate.ts';
import { claudeModeArgs } from './modes.ts';
import { asInput, editDiff, resultEvent, safe, thinkingEvent } from './event-utils.ts';
import { clip, type AgentAdapter, type HubEvent } from './types.ts';

const LOGIN = /not logged in|\/login|invalid api key|authentication/i;
const LIMIT = /usage limit|rate limit|limit reached|out of (extra )?usage|5-hour limit|weekly limit/i;

interface Block { type?: string; text?: string; thinking?: string; id?: string; tool_use_id?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean }

const brief = (b: Block): string => {
  const i = b.input ?? {};
  return clip(redact(String(i['command'] ?? i['file_path'] ?? i['path'] ?? i['pattern'] ?? i['url'] ?? i['description'] ?? JSON.stringify(i))), 300);
};
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' ? (x as Block).text ?? '' : '')).join('\n') : '');

/** Claude Code: `claude -p --output-format stream-json --verbose`. Verified on the author's PC (v2.1.114) for init/assistant/result shapes. */
export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  exe() { const i = locate('claude'); return i.path ? { cmd: i.path, prefix: [] } : undefined; },
  args(r) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose', ...claudeModeArgs(r.permission ?? 'edit'), '--include-partial-messages'];
    if (r.model) a.push('--model', r.model);
    if (r.effort) a.push('--effort', r.effort);
    if (r.resumeId) a.push('--resume', r.resumeId);
    if (r.lean?.length) a.push(...r.lean);
    if (r.extraArgs?.length) a.push(...r.extraArgs);
    return a;
  },
  parse(line): HubEvent[] {
    try { return parseLine(line); } catch { return []; }   // a surprising line must never take the run down
  },
};

type ClaudeLine = { type?: string; subtype?: string; session_id?: string; model?: string; message?: { content?: Block[] }; event?: { type?: string; delta?: { type?: string; text?: string } }; is_error?: boolean; result?: string; duration_ms?: number; usage?: Record<string, number>; total_cost_usd?: number; rate_limit_info?: { status?: string; utilization?: number; resetsAt?: number } };

function parseLine(line: unknown): HubEvent[] {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
  const l = line as ClaudeLine;
  const out: HubEvent[] = [];
  const blocks = (Array.isArray(l.message?.content) ? l.message.content : []).filter((b): b is Block => !!b && typeof b === 'object');
  switch (l.type) {
    case 'system':
      if (l.subtype === 'init' && l.session_id) out.push({ kind: 'session', nativeId: l.session_id, ...(l.model ? { model: l.model } : {}) });
      break;
    case 'assistant':
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: safe(b.text) });
        else if (b.type === 'thinking' && b.thinking?.trim()) out.push(thinkingEvent(b.thinking));
        else if (b.type === 'tool_use' && b.name) {
          const input = asInput(b.input);
          out.push({ kind: 'tool', id: b.id ?? '', name: b.name, summary: brief(b), input });
          const diff = editDiff(b.name, b.input);
          if (diff) out.push(diff);
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.['todos'])) {
            out.push({ kind: 'todo', items: (b.input['todos'] as { content?: unknown; status?: unknown }[]).filter((t) => t && typeof t === 'object').map((t) => ({ text: safe(String(t.content ?? '')), state: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending' })) });
          }
        }
      }
      break;
    case 'user':
      for (const b of blocks) if (b.type === 'tool_result') out.push(resultEvent(b.tool_use_id ?? '', resultText(b.content), !!b.is_error));
      break;
    case 'stream_event': {
      const d = l.event?.type === 'content_block_delta' ? l.event.delta : undefined;
      if (d?.type === 'text_delta' && d.text) out.push({ kind: 'partial', text: safe(d.text) });
      break;
    }
    case 'rate_limit_event':
      if (l.rate_limit_info) {
        // Shape not verified live (the CLI on this PC was not logged in); handled defensively.
        const r = l.rate_limit_info;
        out.push({ kind: 'limit', reached: r.status === 'rejected', message: `status: ${r.status ?? 'unknown'}`, ...(r.utilization != null ? { usedPercent: Math.round(r.utilization * 100) } : {}), ...(r.resetsAt ? { resetsAt: new Date(r.resetsAt * 1000).toISOString() } : {}) });
      }
      break;
    case 'result': {
      const u = l.usage;
      if (u) out.push({ kind: 'usage', uncachedIn: (u['input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0), cachedIn: u['cache_read_input_tokens'] ?? 0, out: u['output_tokens'] ?? 0, ...(l.total_cost_usd != null ? { costUsd: l.total_cost_usd } : {}), ...(typeof l.duration_ms === 'number' ? { ms: l.duration_ms } : {}) });
      if (l.is_error) {
        const msg = redact(l.result ?? 'unknown error');
        if (LOGIN.test(msg)) out.push({ kind: 'error', message: 'Claude CLI is not logged in. Run `claude` in a terminal and use /login.', needsLogin: true });
        else if (LIMIT.test(msg)) out.push({ kind: 'limit', reached: true, message: msg });
        else out.push({ kind: 'error', message: msg });
      }
      out.push({ kind: 'done', ok: !l.is_error });
      break;
    }
    default:
      out.push({ kind: 'unknown', type: typeof l.type === 'string' ? l.type : '(none)' });
  }
  return out;
}
