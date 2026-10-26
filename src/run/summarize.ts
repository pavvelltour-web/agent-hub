import { claudeAdapter } from '../adapters/claude.ts';
import { startAgent } from '../adapters/process.ts';
import type { AgentAdapter, HubEvent } from '../adapters/types.ts';
import { redact } from '../lib/redact.ts';
import type { HandoffInput } from './handoff.ts';

export interface Summary { goal: string; done: string[]; stoppedAt: string; next: string[]; open: string[] }

const strs = (v: unknown, max = 8): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).slice(0, max).map((s) => s.slice(0, 300)) : undefined);

/** Accept only the exact shape; anything else means "no model summary" and the deterministic one is used. */
export function parseSummary(text: string): Summary | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return undefined; }
  const done = strs(j['done']), next = strs(j['next']), open = strs(j['open']);
  if (typeof j['goal'] !== 'string' || typeof j['stoppedAt'] !== 'string' || !done || !next || !open) return undefined;
  return { goal: redact(j['goal'].slice(0, 400)), done: done.map(redact), stoppedAt: redact(j['stoppedAt'].slice(0, 400)), next: next.map(redact), open: open.map(redact) };
}

/**
 * The cheap third model writes the story part of a handoff card (the stopped agent has no tokens left). Facts stay in code.
 * Returns undefined on any problem (not logged in, timeout, bad JSON): the caller falls back to the deterministic summary.
 */
export async function modelSummary(inp: HandoffInput, o: { adapter?: AgentAdapter; exe?: { cmd: string; prefix: string[] }; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Summary | undefined> {
  const recent = inp.events.filter((e): e is Extract<HubEvent, { kind: 'text' | 'tool' | 'tool_result' }> => e.kind === 'text' || e.kind === 'tool' || e.kind === 'tool_result')
    .slice(-24).map((e) => (e.kind === 'text' ? `assistant: ${e.text.slice(0, 500)}` : e.kind === 'tool' ? `tool ${e.name}: ${e.summary}` : `result${e.isError ? ' (error)' : ''}: ${e.summary}`)).join('\n');
  const prompt = `Summarize an interrupted coding task for the agent that will continue it. Return ONLY JSON, no prose:\n{"goal": string, "done": string[], "stoppedAt": string, "next": string[], "open": string[]}\n` +
    `Rules: be concrete, max 8 items per list, no secrets, do not invent facts; if unsure put it in "open".\n\nTask:\n${inp.prompt.slice(0, 1500)}\n\nLast events:\n${recent}\n`;
  const text: string[] = []; let bad = false;
  const h = startAgent(o.adapter ?? claudeAdapter, { prompt, cwd: inp.cwd, model: 'haiku', effort: 'low', permission: 'plan' },
    (e) => { if (e.kind === 'text') text.push(e.text); if (e.kind === 'error') bad = true; }, { ...(o.exe ? { exe: o.exe } : {}), ...(o.env ? { env: o.env } : {}), timeoutMs: o.timeoutMs ?? 45_000 });
  await h.done;
  return bad ? undefined : parseSummary(text.join('\n'));
}
