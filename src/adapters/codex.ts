import { redact } from '../lib/redact.ts';
import { locate } from './locate.ts';
import { codexModeArgs } from './modes.ts';
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

interface Item { type?: string; text?: string; message?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: { path?: string; kind?: string }[]; server?: string; tool?: string }

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
    const l = line as { type?: string; thread_id?: string; item?: Item; usage?: Record<string, number>; message?: string; error?: { message?: string } };
    const out: HubEvent[] = [];
    if (l.type === 'thread.started' && l.thread_id) out.push({ kind: 'session', nativeId: l.thread_id });
    else if (l.type === 'item.completed' && l.item) {
      const it = l.item;
      if (it.type === 'agent_message' && it.text?.trim()) out.push({ kind: 'text', text: redact(it.text) });
      else if (it.type === 'command_execution') {
        out.push({ kind: 'tool', name: 'shell', summary: clip(redact(it.command ?? ''), 300) });
        if (it.aggregated_output != null || it.exit_code != null) out.push({ kind: 'tool_result', summary: clip(redact(it.aggregated_output ?? ''), 300), ...(it.exit_code ? { isError: true } : {}) });
      } else if (it.type === 'file_change') out.push({ kind: 'tool', name: 'edit', summary: clip((it.changes ?? []).map((c) => `${c.kind ?? 'change'} ${c.path ?? ''}`).join(', '), 300) });
      else if (it.type === 'mcp_tool_call') out.push({ kind: 'tool', name: `mcp:${it.server ?? ''}/${it.tool ?? ''}`, summary: '' });
      else if (it.type === 'error' && it.message) out.push(/skills context budget/i.test(it.message) ? { kind: 'warn', message: it.message } : { kind: 'error', message: redact(it.message) });
    } else if (l.type === 'turn.completed' && l.usage) {
      const u = l.usage;
      out.push({ kind: 'usage', uncachedIn: Math.max(0, (u['input_tokens'] ?? 0) - (u['cached_input_tokens'] ?? 0)), cachedIn: u['cached_input_tokens'] ?? 0, out: u['output_tokens'] ?? 0, ...(u['reasoning_output_tokens'] ? { reasoning: u['reasoning_output_tokens'] } : {}) });
    } else if (l.type === 'turn.failed' || l.type === 'error') {
      const msg = redact(l.error?.message ?? l.message ?? 'unknown error');
      if (LIMIT.test(msg)) { const at = parseResetTime(msg); out.push({ kind: 'limit', reached: true, message: msg, ...(at ? { resetsAt: at } : {}) }); }
      else out.push({ kind: 'error', message: msg });
    }
    return out;
  },
};
