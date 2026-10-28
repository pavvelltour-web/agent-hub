import { redact } from '../lib/redact.ts';

const GOAL_MAX = 200;

/** The user's own words: the mode rules block, a mode's prefix and a slash command the hub added are not part of the goal. Redacted, one line, clipped. */
export function goalOf(prompt: string | null, prefixes: string[] = []): string {
  let t = String(prompt ?? '').replace(/\[mode rules: [^\]\n]*\][\s\S]*?\[end mode rules\]\s*/g, '');
  for (const p of prefixes) if (p) t = t.split(p).join('');
  t = redact(t.replace(/^\s*\/(?:autopilot\s+\w+\s+\w+|grill-me)\s+/, '')).replace(/\s+/g, ' ').trim();
  return t.length > GOAL_MAX ? `${t.slice(0, GOAL_MAX)}…` : t;
}
