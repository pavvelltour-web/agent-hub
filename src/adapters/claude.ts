import { redact } from '../lib/redact.ts';
import { locate } from './locate.ts';
import { claudeModeArgs } from './modes.ts';
import { clip, type AgentAdapter, type HubEvent } from './types.ts';

const LOGIN = /not logged in|\/login|invalid api key|authentication/i;
const LIMIT = /usage limit|rate limit|limit reached|out of (extra )?usage|5-hour limit|weekly limit/i;

interface Block { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean }

const brief = (b: Block): string => {
  const i = b.input ?? {};
  return clip(redact(String(i['command'] ?? i['file_path'] ?? i['path'] ?? i['pattern'] ?? i['url'] ?? i['description'] ?? JSON.stringify(i))), 300);
};
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as Block).text ?? '').join(' ') : '');

/** Claude Code: `claude -p --output-format stream-json --verbose`. Verified on the author's PC (v2.1.114) for init/assistant/result shapes. */
export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  exe() { const i = locate('claude'); return i.path ? { cmd: i.path, prefix: [] } : undefined; },
  args(r) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose', ...claudeModeArgs(r.permission ?? 'edit')];
    if (r.model) a.push('--model', r.model);
    if (r.effort) a.push('--effort', r.effort);
    if (r.resumeId) a.push('--resume', r.resumeId);
    if (r.lean?.length) a.push(...r.lean);
    return a;
  },
  parse(line): HubEvent[] {
    const l = line as { type?: string; subtype?: string; session_id?: string; model?: string; message?: { content?: Block[] }; is_error?: boolean; result?: string; usage?: Record<string, number>; total_cost_usd?: number; rate_limit_info?: { status?: string; utilization?: number; resetsAt?: number } };
    const out: HubEvent[] = [];
    if (l.type === 'system' && l.subtype === 'init' && l.session_id) out.push({ kind: 'session', nativeId: l.session_id, ...(l.model ? { model: l.model } : {}) });
    else if (l.type === 'assistant' && Array.isArray(l.message?.content)) {
      for (const b of l.message.content) {
        if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: redact(b.text) });
        else if (b.type === 'tool_use' && b.name) out.push({ kind: 'tool', name: b.name, summary: brief(b) });
      }
    } else if (l.type === 'user' && Array.isArray(l.message?.content)) {
      for (const b of l.message.content) if (b.type === 'tool_result') out.push({ kind: 'tool_result', summary: clip(redact(resultText(b.content)), 300), ...(b.is_error ? { isError: true } : {}) });
    } else if (l.type === 'rate_limit_event' && l.rate_limit_info) {
      // Shape not verified live (the CLI on this PC was not logged in); handled defensively.
      const r = l.rate_limit_info;
      out.push({ kind: 'limit', reached: r.status === 'rejected', message: `status: ${r.status ?? 'unknown'}`, ...(r.utilization != null ? { usedPercent: Math.round(r.utilization * 100) } : {}), ...(r.resetsAt ? { resetsAt: new Date(r.resetsAt * 1000).toISOString() } : {}) });
    } else if (l.type === 'result') {
      const u = l.usage;
      if (u) out.push({ kind: 'usage', uncachedIn: (u['input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0), cachedIn: u['cache_read_input_tokens'] ?? 0, out: u['output_tokens'] ?? 0, ...(l.total_cost_usd != null ? { costUsd: l.total_cost_usd } : {}) });
      if (l.is_error) {
        const msg = redact(l.result ?? 'unknown error');
        if (LOGIN.test(msg)) out.push({ kind: 'error', message: 'Claude CLI is not logged in. Run `claude` in a terminal and use /login.', needsLogin: true });
        else if (LIMIT.test(msg)) out.push({ kind: 'limit', reached: true, message: msg });
        else out.push({ kind: 'error', message: msg });
      }
      out.push({ kind: 'done', ok: !l.is_error });
    }
    return out;
  },
};
