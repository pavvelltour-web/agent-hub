import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Permission } from '../adapters/types.ts';
import type { TaskClass } from '../econ/router.ts';
import type { StartReq } from '../run/runner.ts';
import { REPO_ROOT } from './registry.ts';

export interface WorkMode {
  id: string; title: string; hint: string; permission: Permission; cls: TaskClass; worktree: boolean; skills: string[];
  /** MCP servers (hub-library names) this mode may use. When set, a run starts only those (`--strict-mcp-config`); when absent MCP is left as the user configured it. */
  mcp?: string[];
  review: 'none' | 'on-stuck' | 'phase';
  autopilot?: { mode: 'full' | 'semi' | 'interview' | 'manual'; depth: 'strict' | 'normal' | 'deep' };
  promptPrefix?: string;
}

const ORDER = ['chat', 'task', 'interview', 'autopilot', 'review'];
const PERMS = ['plan', 'edit', 'full'], CLASSES = ['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary'];
const REVIEWS = ['none', 'on-stuck', 'phase'], AP_MODES = ['full', 'semi', 'interview', 'manual'], AP_DEPTHS = ['strict', 'normal', 'deep'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseWorkMode(raw: unknown): WorkMode {
  const m = raw as Partial<WorkMode> | null;
  const bad = (why: string): never => { throw new Error(`work mode ${m && typeof m === 'object' ? String(m.id ?? '?') : '?'}: ${why}`); };
  if (!m || typeof m !== 'object') return bad('not an object');
  if (typeof m.id !== 'string' || !NAME.test(m.id)) bad('bad id');
  if (typeof m.title !== 'string' || !m.title || typeof m.hint !== 'string' || !m.hint) bad('title and hint are required');
  if (!PERMS.includes(m.permission as string)) bad('bad permission');
  if (!CLASSES.includes(m.cls as string)) bad('bad class');
  if (typeof m.worktree !== 'boolean') bad('worktree must be true or false');
  if (!Array.isArray(m.skills) || m.skills.some((s) => typeof s !== 'string' || !NAME.test(s))) bad('bad skills');
  if (m.mcp !== undefined && (!Array.isArray(m.mcp) || m.mcp.some((s) => typeof s !== 'string' || !NAME.test(s)))) bad('bad mcp');
  if (!REVIEWS.includes(m.review as string)) bad('bad review');
  if (m.autopilot && (!AP_MODES.includes(m.autopilot.mode) || !AP_DEPTHS.includes(m.autopilot.depth))) bad('bad autopilot settings');
  if (m.promptPrefix !== undefined && typeof m.promptPrefix !== 'string') bad('bad promptPrefix');
  return m as WorkMode;
}

export function loadWorkModes(dir: string = join(REPO_ROOT, 'modes')): WorkMode[] {
  const all = ORDER.map((id) => join(dir, `${id}.json`)).filter(existsSync).map((f) => parseWorkMode(JSON.parse(readFileSync(f, 'utf8')) as unknown));
  return all;
}

/** A skill counts as linked when its SKILL.md is in the project's or the user's skill folder that this agent reads. */
function skillLinked(agent: 'claude' | 'codex', projectRoot: string, name: string, home: string): boolean {
  const folders = agent === 'claude' ? [join(projectRoot, '.claude', 'skills'), join(home, '.claude', 'skills')] : [join(projectRoot, '.agents', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills')];
  return folders.some((d) => existsSync(join(d, name, 'SKILL.md')));
}

/** Turns a work mode and a request into the request the runner takes. Throws a plain message when the mode cannot work here. */
export function applyWorkMode(m: WorkMode, req: StartReq, o: { home?: string } = {}): StartReq {
  const home = o.home ?? homedir();
  let prompt = req.prompt;
  if (m.autopilot) {
    if (req.agent !== 'claude') throw new Error('autopilot works with Claude only (Автопилот работает только с Claude)');
    if (!skillLinked('claude', req.projectRoot, 'autopilot', home)) throw new Error('install the autopilot skill in Tools (Установите навык autopilot во вкладке «Инструменты»)');
    prompt = `/autopilot ${m.autopilot.mode} ${m.autopilot.depth} ${prompt}`;
  } else if (m.promptPrefix) prompt = m.promptPrefix + prompt;
  return {
    ...req, prompt,
    permission: m.id === 'review' ? 'plan' : req.permission ?? m.permission,
    cls: m.autopilot ? m.cls : req.cls ?? m.cls,   // a lighter class would switch slash commands off and strand the /autopilot prefix
    mode: m.worktree ? 'task' : 'chat',
    workMode: m.id,
  };
}
