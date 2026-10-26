import { redact } from '../lib/redact.ts';
import { locate } from './locate.ts';
import { codexModeArgs } from './modes.ts';
import { asInput, resultEvent, safe, thinkingEvent } from './event-utils.ts';
import { clip, type AgentAdapter, type HubEvent } from './types.ts';

const LIMIT = /usage limit|rate limit|hit your .*limit/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "try again at Oct 27th, 2026 12:03 PM" → ISO time (interpreted in the machine's local time zone). */
export function parseResetTime(msg: string): string | undefined {
  const m = /try again at ([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}):(\d{2}) ?(AM|PM)/i.exec(msg);
  if (!m) return undefined;
  const mon = MONTHS.indexOf((m[1] as string).toLowerCase());
  if (mon < 0) return undefined;
  let h = Number(m[4]) % 12;
  if ((m[6] as string).toUpperCase() === 'PM') h += 12;
  return new Date(Number(m[3]), mon, Number(m[2]), h, Number(m[5])).toISOString();
}

interface Item { id?: string; type?: string; text?: string; query?: string; arguments?: unknown; items?: { text?: string; completed?: boolean }[]; message?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: { path?: string; kind?: string }[]; server?: string; tool?: string }

/**
 * Codex: `codex exec --json`. Verified live for thread.started / turn.started / item.completed(error) / turn.failed (the account was at its
 * limit, so the success path is written from Codex's documented item types and NOT yet confirmed on this machine).
 */
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  exe() { const i = locate('codex'); return i.path ? { cmd: i.path, prefix: [] } : undefined; },
  args(r) {
    if (r.resumeId) return ['exec', 'resume', r.resumeId, '--json', ...codexModeArgs(r.permission ?? 'edit', true), ...(r.model ? ['-m', r.model] : []), ...(r.effort ? ['-c', `model_reasoning_effort=${r.effort}`] : []), '-'];
    return ['exec', '--json', ...codexModeArgs(r.permission ?? 'edit', false), ...(r.model ? ['-m', r.model] : []), ...(r.effort ? ['-c', `model_reasoning_effort=${r.effort}`] : []), '-'];
  },
  parse(line): HubEvent[] {
    try { return parseLine(line); } catch { return []; }   // a surprising line must never take the run down
  },
};

type CodexLine = { type?: string; thread_id?: string; item?: Item; usage?: Record<string, number>; message?: string; error?: { message?: string } };

function parseLine(line: unknown): HubEvent[] {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
  const l = line as CodexLine;
  const out: HubEvent[] = [];
  switch (l.type) {
    case 'thread.started':
      if (l.thread_id) out.push({ kind: 'session', nativeId: l.thread_id });
      break;
    case 'turn.started': case 'item.started': case 'item.updated':
      break;
    case 'item.completed': {
      const it = l.item;
      if (!it || typeof it !== 'object') break;
      const id = it.id ?? '';
      if (it.type === 'agent_message') { if (it.text?.trim()) out.push({ kind: 'text', text: safe(it.text) }); }
      else if (it.type === 'reasoning') { if (it.text?.trim()) out.push(thinkingEvent(it.text)); }
      else if (it.type === 'command_execution') {
        out.push({ kind: 'tool', id, name: 'shell', summary: clip(redact(it.command ?? ''), 300), input: asInput({ command: it.command ?? '' }) });
        if (it.aggregated_output != null || it.exit_code != null) out.push(resultEvent(id, it.aggregated_output ?? '', !!it.exit_code));
      } else if (it.type === 'file_change') {
        const changes = Array.isArray(it.changes) ? it.changes.filter((c) => c && typeof c === 'object') : [];
        out.push({ kind: 'tool', id, name: 'edit', summary: clip(redact(changes.map((c) => `${c.kind ?? 'change'} ${c.path ?? ''}`).join(', ')), 300), input: asInput({ changes }) });
        // Codex reports only the path and kind, so the +/- counts are unknown (0) and there are no hunks.
        for (const c of changes) if (c.path) out.push({ kind: 'diff', path: safe(c.path), added: 0, removed: 0, hunks: '' });
      } else if (it.type === 'mcp_tool_call') out.push({ kind: 'tool', id, name: `mcp:${it.server ?? ''}/${it.tool ?? ''}`, summary: '', input: asInput(it.arguments) });
      else if (it.type === 'web_search') out.push({ kind: 'tool', id, name: 'web_search', summary: clip(redact(it.query ?? ''), 300), input: asInput({ query: it.query ?? '' }) });
      else if (it.type === 'todo_list') out.push({ kind: 'todo', items: (Array.isArray(it.items) ? it.items : []).filter((t) => t && typeof t === 'object').map((t) => ({ text: safe(t.text ?? ''), state: t.completed ? 'done' : 'pending' })) });
      else if (it.type === 'error') { if (it.message) out.push(/skills context budget/i.test(it.message) ? { kind: 'warn', message: it.message } : { kind: 'error', message: redact(it.message) }); }
      else out.push({ kind: 'unknown', type: `item.${typeof it.type === 'string' ? it.type : ''}` });
      break;
    }
    case 'turn.completed':
      if (l.usage) {
        const u = l.usage;
        out.push({ kind: 'usage', uncachedIn: Math.max(0, (u['input_tokens'] ?? 0) - (u['cached_input_tokens'] ?? 0)), cachedIn: u['cached_input_tokens'] ?? 0, out: u['output_tokens'] ?? 0, ...(u['reasoning_output_tokens'] ? { reasoning: u['reasoning_output_tokens'] } : {}) });
      }
      break;
    case 'turn.failed': case 'error': {
      const msg = redact(l.error?.message ?? l.message ?? 'unknown error');
      if (LIMIT.test(msg)) { const at = parseResetTime(msg); out.push({ kind: 'limit', reached: true, message: msg, ...(at ? { resetsAt: at } : {}) }); }
      else out.push({ kind: 'error', message: msg });
      break;
    }
    default:
      out.push({ kind: 'unknown', type: typeof l.type === 'string' ? l.type : '(none)' });
  }
  return out;
}
