import { join } from 'node:path';
import { change, effective, readText } from './plan.ts';
import type { HookReport } from './hooks.ts';
import type { Plan } from './types.ts';

/** Claude/Codex event → the point in the hub runner where the same command runs for any agent. */
const EVENT_MAP: Record<string, 'sessionStart' | 'sessionEnd'> = { SessionStart: 'sessionStart', Stop: 'sessionEnd', SubagentStop: 'sessionEnd', Interrupt: 'sessionEnd' };
const SHELL_SYNTAX = /[|&;<>`]|\$[({A-Za-z_]|%[A-Za-z_]+%|^\s*(cd|set|export)\s/;

/** Split a command line into an argument array without a shell. Returns undefined when it needs a shell. */
export function tokenize(cmd: string): string[] | undefined {
  if (SHELL_SYNTAX.test(cmd)) return undefined;
  const out: string[] = []; let cur = ''; let q: string | null = null; let any = false;
  for (const ch of cmd.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ''; any = false; } }
    else cur += ch;
  }
  if (q) return undefined;
  if (cur || any) out.push(cur);
  return out.length ? out : undefined;
}

export interface AdoptResult { plan: Plan; adopted: { event: string; as: string; argv: string[] }[]; skipped: { event: string; command: string; why: string }[] }

/**
 * Turn classified hooks into hub runner hooks in `hub.json` (`hooks.sessionStart` / `hooks.sessionEnd`, argv lists).
 * Only simple commands are adopted; anything that needs a shell, has a matcher or an unmapped event is reported, never guessed.
 */
export function adoptHooks(root: string, reports: HookReport[]): AdoptResult {
  const path = join(root, 'hub.json');
  const raw = readText(path);
  if (!raw) throw new Error('no hub.json here: run `hub init` first');
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('hub.json is not valid JSON; refusing to overwrite'); }
  const hooks = { sessionStart: [] as string[][], sessionEnd: [] as string[][], ...((cfg['hooks'] as object | undefined) ?? {}) } as Record<string, string[][]>;
  const adopted: AdoptResult['adopted'] = []; const skipped: AdoptResult['skipped'] = [];
  for (const r of reports) {
    const slot = EVENT_MAP[r.event];
    const cmd = r.codexCommand ?? r.command;
    if (!slot) { skipped.push({ event: r.event, command: r.command, why: `event ${r.event} has no hub runner point (only SessionStart, Stop, SubagentStop, Interrupt)` }); continue; }
    if (r.matcher) { skipped.push({ event: r.event, command: r.command, why: `matcher "${r.matcher}" is tool-specific; the runner has no tool events` }); continue; }
    if (r.codex === 'unsupported') { skipped.push({ event: r.event, command: r.command, why: r.notes.join('; ') || 'unsupported hook type' }); continue; }
    const argv = tokenize(cmd);
    if (!argv) { skipped.push({ event: r.event, command: r.command, why: 'needs a shell (pipes, redirects, variables); rewrite as a script and adopt the script' }); continue; }
    const list = hooks[slot] as string[][];
    if (!list.some((x) => JSON.stringify(x) === JSON.stringify(argv))) list.push(argv);
    adopted.push({ event: r.event, as: slot, argv });
  }
  const after = JSON.stringify({ ...cfg, hooks }, null, 2) + '\n';
  return { plan: effective({ root, changes: adopted.length ? [change(path, after, `hub runner hooks adopted (${adopted.length})`)] : [], notes: [] }), adopted, skipped };
}
