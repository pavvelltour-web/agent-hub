import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Permission } from '../adapters/types.ts';
import { MODEL_ID, type TaskClass } from '../econ/router.ts';
import type { StartReq } from '../run/runner.ts';
import { REPO_ROOT, library } from './registry.ts';
import type { AgentId, RegistryEntry } from './types.ts';

export interface WorkMode {
  id: string; title: string; hint: string; permission: Permission; cls: TaskClass; worktree: boolean;
  /** Skills are on or off for a run, not filtered per skill: `[]` starts it with skills off (`--disable-slash-commands`); ANY non-empty list keeps them on. `["*"]` is the explicit "all"; names (autopilot) say which one the mode relies on. */
  skills: string[];
  /** MCP servers (hub-library names) this mode may use. When set (even `[]`), a run starts only those and nothing else (`--strict-mcp-config`); when absent MCP is left as the user configured it. */
  mcp?: string[];
  /** Skills the mode uses when they are linked for the agent (Interview: `grill-me`). Linked: skills stay on and the prompt calls it (Claude only); not linked: the mode runs without it, nothing fails. Names only, never `*`. */
  skillsIfLinked?: string[];
  /** Who runs this mode when the caller did not name an agent: `prefer` when it is signed in, else `fallback`. Data only: the permission stays the mode's own (review: plan). */
  reviewer?: { prefer: AgentId; fallback: AgentId };
  review: 'none' | 'on-stuck' | 'phase';
  autopilot?: { mode: 'full' | 'semi' | 'interview' | 'manual'; depth: 'strict' | 'normal' | 'deep' };
  promptPrefix?: string;
}

const ORDER = ['chat', 'task', 'interview', 'autopilot', 'review'];
const PERMS = ['plan', 'edit', 'full'], CLASSES = ['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary'];
const REVIEWS = ['none', 'on-stuck', 'phase'], AP_MODES = ['full', 'semi', 'interview', 'manual'], AP_DEPTHS = ['strict', 'normal', 'deep'];
const AGENTS = ['claude', 'codex'];
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
  if (!Array.isArray(m.skills) || m.skills.some((s) => typeof s !== 'string' || !NAME.test(s) && s !== '*') || (m.skills.includes('*') && m.skills.length > 1)) bad('bad skills');   // "*" is the one wildcard and stands alone
  if (m.mcp !== undefined && (!Array.isArray(m.mcp) || m.mcp.some((s) => typeof s !== 'string' || !NAME.test(s)))) bad('bad mcp');
  if (m.skillsIfLinked !== undefined && (!Array.isArray(m.skillsIfLinked) || m.skillsIfLinked.some((s) => typeof s !== 'string' || !NAME.test(s)))) bad('bad skillsIfLinked');
  const rv = m.reviewer as { prefer?: unknown; fallback?: unknown } | undefined;
  if (rv !== undefined && (!rv || typeof rv !== 'object' || !AGENTS.includes(rv.prefer as string) || !AGENTS.includes(rv.fallback as string))) bad('bad reviewer');
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
export function skillLinked(agent: 'claude' | 'codex', projectRoot: string, name: string, home: string): boolean {
  const folders = agent === 'claude' ? [join(projectRoot, '.claude', 'skills'), join(home, '.claude', 'skills')] : [join(projectRoot, '.agents', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills')];
  return folders.some((d) => existsSync(join(d, name, 'SKILL.md')));
}

export interface ApplyOpts { home?: string; /** the hub library (tests inject it; default: `library(project)`, read only when a skill is not linked) */ library?: RegistryEntry[] }

/** The skill is linked for this agent, only in the hub library (present, but no agent loads it), or nowhere. */
function skillState(agent: 'claude' | 'codex', projectRoot: string, name: string, o: ApplyOpts): 'linked' | 'in-library' | 'missing' {
  if (skillLinked(agent, projectRoot, name, o.home ?? homedir())) return 'linked';
  let lib = o.library;
  if (!lib) { try { lib = library(projectRoot); } catch { lib = []; } }
  return lib.some((e) => e.id === `skill/${name}` && e.source?.type === 'local') ? 'in-library' : 'missing';
}

const FIX_AP = (root: string): string => `hub init "${root}" --add skill/autopilot --yes`;

/** `ready[agent]`: installed and signed in (from the adapter status, never from a credential file). */
export type Ready = Partial<Record<AgentId, boolean>>;
export interface ModeReviewer { agent: AgentId; model?: string; effort: string; note: string }

/**
 * The mode's own reviewer choice (`reviewer` data): `prefer` when it is ready, else `fallback`, else a plain refusal. Nothing here changes the
 * permission: the caller still passes the request through `applyWorkMode`, which keeps review at `plan`. Claude is Opus; Codex keeps the
 * account's default model (no model id is guessed). `undefined` for a mode with no reviewer data.
 */
export function pickModeReviewer(m: WorkMode, ready: Ready): ModeReviewer | undefined {
  if (!m.reviewer) return undefined;
  const label = (a: AgentId): string => (a === 'codex' ? 'Codex' : 'Opus');
  const mk = (a: AgentId, note: string): ModeReviewer => ({ agent: a, ...(a === 'claude' ? { model: MODEL_ID.opus } : {}), effort: 'high', note });
  if (ready[m.reviewer.prefer]) return mk(m.reviewer.prefer, `${label(m.reviewer.prefer)} is signed in: another vendor reviews, read-only`);
  if (ready[m.reviewer.fallback]) return mk(m.reviewer.fallback, `${m.reviewer.prefer === 'codex' ? 'Codex' : 'Claude'} is not signed in: ${label(m.reviewer.fallback)} reviews, read-only`);
  throw new Error(`${m.title} needs a signed-in agent: sign in to Codex or Claude (Войдите в Codex или Claude, чтобы запустить ревью)`);
}

/** Turns a work mode and a request into the request the runner takes. Throws a plain message when the mode cannot work here. */
export function applyWorkMode(m: WorkMode, req: StartReq, o: ApplyOpts = {}): StartReq {
  let prompt = req.prompt;
  if (m.autopilot) {
    if (req.agent !== 'claude') throw new Error('autopilot works with Claude only (Автопилот работает только с Claude)');
    const st = skillState('claude', req.projectRoot, 'autopilot', o);
    if (st === 'in-library') throw new Error(`autopilot is in your hub library but not linked to Claude in this project. Link it: ${FIX_AP(req.projectRoot)} (Навык autopilot есть в библиотеке, но не подключён к проекту: выполните команду выше)`);
    if (st === 'missing') throw new Error(`install the autopilot skill in Tools, then link it: ${FIX_AP(req.projectRoot)} (Установите навык autopilot во вкладке «Инструменты» и подключите его командой выше)`);
    prompt = `/autopilot ${m.autopilot.mode} ${m.autopilot.depth} ${prompt}`;
  } else {
    if (m.promptPrefix) prompt = m.promptPrefix + prompt;
    // optional skills: only Claude takes a slash command here; a missing one is not an error (leanPlan says so in the run)
    const first = req.agent === 'claude' ? (m.skillsIfLinked ?? []).find((n) => skillLinked('claude', req.projectRoot, n, o.home ?? homedir())) : undefined;
    if (first) prompt = `/${first} ${prompt}`;
  }
  return {
    ...req, prompt,
    permission: m.id === 'review' ? 'plan' : req.permission ?? m.permission,
    cls: m.autopilot ? m.cls : req.cls ?? m.cls,   // a lighter class would switch slash commands off and strand the /autopilot prefix
    mode: m.worktree ? 'task' : 'chat',
    workMode: m.id,
  };
}
