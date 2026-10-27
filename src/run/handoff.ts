import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HubEvent } from '../adapters/types.ts';
import { redact } from '../lib/redact.ts';
import { checkpoint, facts, git, type Facts } from './git.ts';

export interface HandoffInput {
  runId: string; task: string; prompt: string; from: { agent: string; model?: string; effort?: string }; reason: 'limit_reached' | 'limit_soon' | 'manual' | 'failed' | 'context';
  cwd: string; baseSha?: string; events: HubEvent[]; resetsAt?: string; to?: { agent: string; model?: string; effort?: string };
}
export interface Card { id: string; path: string; markdown: string; facts: Facts & { committed: boolean; checkpointNote?: string }; summaryBy: 'deterministic' | string }

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Deterministic summary from the event log. A model-written summary may replace it (same sections), and the card says which one it is. */
export function deterministicSummary(inp: HandoffInput): { goal: string; done: string[]; stoppedAt: string; next: string[]; open: string[] } {
  const texts = inp.events.filter((e): e is Extract<HubEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text);
  const tools = inp.events.filter((e): e is Extract<HubEvent, { kind: 'tool' }> => e.kind === 'tool');
  const results = inp.events.filter((e): e is Extract<HubEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
  const edits = [...new Set(tools.filter((t) => /edit|write|patch|multiedit/i.test(t.name)).map((t) => t.summary))].slice(-8);
  const lastFail = [...results].reverse().find((r) => r.isError);
  const lastText = texts.at(-1) ?? '';
  return {
    goal: clip(inp.prompt.replace(/\s+/g, ' '), 400),
    done: [...edits.map((e) => `edited: ${e}`), ...(tools.length ? [`${tools.length} tool calls`] : [])].slice(0, 10),
    stoppedAt: clip(lastText || tools.at(-1)?.summary || 'no output before the stop', 400),
    next: [lastFail ? `fix the failing step: ${clip(lastFail.summary, 160)}` : 'review the changed files and continue the task', 'run the tests before reporting done'],
    open: lastFail ? ['the last tool result was an error (see above)'] : [],
  };
}

/** Write `.hub/handoffs/<id>.md`: facts from git (code, not a model) + a short story. Commits a checkpoint first. */
export function writeCard(hubDir: string, inp: HandoffInput, summary = deterministicSummary(inp), summaryBy = 'deterministic'): Card {
  // Commit only on a hub-owned branch. In the user's own working tree we never commit on their behalf.
  const onHubBranch = git(inp.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.startsWith('hub/');
  const cp = onHubBranch ? checkpoint(inp.cwd, `hub: checkpoint before handoff (${inp.reason})`) : { committed: false, sha: git(inp.cwd, ['rev-parse', 'HEAD']).out, note: 'not committed: the agent worked in your own working tree, not in a hub/ branch' };
  const f = facts(inp.cwd, inp.baseSha);
  const id = `ho-${new Date().toISOString().slice(0, 10)}-${inp.runId.slice(-6)}`;
  const dir = join(hubDir, 'handoffs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  const head = [
    '---', `id: ${id}`, `run: ${inp.runId}`, `task: ${JSON.stringify(inp.task)}`,
    `from: ${JSON.stringify(inp.from)}`, ...(inp.to ? [`to: ${JSON.stringify(inp.to)}`] : []), `reason: ${inp.reason}`,
    ...(inp.resetsAt ? [`resets_at: ${inp.resetsAt}`] : []), `branch: ${f.branch}`, ...(inp.baseSha ? [`base_sha: ${inp.baseSha}`] : []), `head_sha: ${f.head}`,
    `checkpoint_committed: ${cp.committed}`, ...(cp.note ? [`checkpoint_note: ${JSON.stringify(cp.note)}`] : []),
    `files_changed: ${JSON.stringify(f.changed.map((c) => c.path))}`, 'facts_from: git+logs', `summary_by: ${summaryBy}`, '---',
  ].join('\n');
  const list = (a: string[]): string => (a.length ? a.map((x) => `- ${x}`).join('\n') : '- none');
  const body = `\n## Goal\n${summary.goal}\n\n## Done\n${list(summary.done)}\n\n## Stopped at\n${summary.stoppedAt}\n\n## Next steps\n${summary.next.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n## Open questions\n${list(summary.open)}\n`;
  const markdown = redact(head + body);
  writeFileSync(path, markdown, 'utf8');
  return { id, path, markdown, facts: { ...f, committed: cp.committed, ...(cp.note ? { checkpointNote: cp.note } : {}) }, summaryBy };
}

/** The prompt the next agent receives: the card + the rules of continuing. No transcript. */
export const handoffPrompt = (card: Card, originalPrompt: string): string =>
  (/^reason: context$/m.test(card.markdown)
    ? `You are continuing work a previous session of this task started. Its context grew large, so you are a fresh session: the card below is all you carry over. Do not start over and do not ask the user to re-explain.\n\n`
    : `You are continuing work another coding agent started and had to stop (its usage limit ended). Do not start over and do not ask the user to re-explain.\n\n`) +
  `Original task:\n${originalPrompt}\n\nHandoff card (facts were collected by code from git and logs):\n\n${card.markdown}\n\n` +
  `Rules: work on branch ${card.facts.branch} in the current folder; check \`git status\` and the failing step first; run the tests before you say "done"; do not push.`;
