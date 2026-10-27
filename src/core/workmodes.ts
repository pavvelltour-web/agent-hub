import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Permission } from '../adapters/types.ts';
import { MODEL_ID, type TaskClass } from '../econ/router.ts';
import type { StartReq } from '../run/runner.ts';
import { HUB_HOME, REPO_ROOT, library, loadUserConfig } from './registry.ts';
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

/** Folders whose skills the hub vouches for: its own library and the folders the user added. */
const defaultHubRoots = (): string[] => { try { return [join(HUB_HOME, 'skills'), ...(loadUserConfig().extraSkillRoots ?? [])]; } catch { return []; } };
const real = (p: string): string | undefined => { try { return realpathSync.native(p); } catch { return undefined; } };
const inside = (p: string, root: string): boolean => { const a = p.toLowerCase().replace(/\\/g, '/'), b = root.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); return a === b || a.startsWith(b + '/'); };

/**
 * Like `skillLinked` for Claude, but for a skill the hub types as a slash command and turns skills on for: the user's own `~/.claude/skills`
 * count, a project folder counts only when it is a link that resolves into the hub library (what `hub init` makes). A plain folder in the
 * project is not trusted: a cloned repository can ship its own `.claude/skills/<name>` and the hub would then type `/<name>` for it.
 */
export function trustedSkillLinked(projectRoot: string, name: string, home: string, hubRoots: string[] = defaultHubRoots()): boolean {
  if (existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))) return true;
  const dir = join(projectRoot, '.claude', 'skills', name);
  if (!existsSync(join(dir, 'SKILL.md'))) return false;
  const r = real(dir);
  return !!r && hubRoots.some((h) => { const hr = real(h); return !!hr && inside(r, hr); });
}

export interface ApplyOpts { home?: string; /** the hub library (tests inject it; default: `library(project)`, read only when a skill is not linked) */ library?: RegistryEntry[]; /** tests: the folders that count as the hub library for `trustedSkillLinked` */ hubRoots?: string[] }

/** The skill is linked for this agent, only in the hub library (present, but no agent loads it), or nowhere. */
function skillState(agent: 'claude' | 'codex', projectRoot: string, name: string, o: ApplyOpts): 'linked' | 'in-library' | 'missing' {
  if (skillLinked(agent, projectRoot, name, o.home ?? homedir())) return 'linked';
  let lib = o.library;
  if (!lib) { try { lib = library(projectRoot); } catch { lib = []; } }
  return lib.some((e) => e.id === `skill/${name}` && e.source?.type === 'local') ? 'in-library' : 'missing';
}

/** A refusal with a Russian sentence the panel shows, and the command to run (when one can be printed safely) shown apart from the sentence. */
export class WorkModeError extends Error {
  readonly ru: string; readonly command: string | undefined;
  constructor(en: string, ru: string, command?: string) { super(`${en}${command ? `: ${command}` : ''} (${ru})`); this.name = 'WorkModeError'; this.ru = ru; this.command = command; }
}

const UNSAFE_RU = 'путь содержит символы, которые нельзя безопасно вставить: добавьте скилл вручную в окне Начало';
/** Characters that cannot go into a command line safely: `%` (cmd expands it even inside quotes), `"`, control characters and line breaks, and the typographic single quotes PowerShell also treats as quotes. */
const UNSAFE = /[%"\u0000-\u001f\u007f-\u009f\u2018-\u201b\u2028\u2029]/;
/**
 * The command that links the autopilot skill into a project, for PowerShell: `node bin/hub.js` (run in the Agent Hub folder; `hub` is not on the PATH
 * for the clone-and-run start and collides with GitHub's `hub`), the root as a SINGLE-quoted literal (nothing expands in it, `$old` stays `$old`; a
 * quote is doubled). A root with a character that cannot be quoted safely gets no command, only the sentence that says what to do by hand.
 */
export function autopilotFix(root: string): { command: string; ru?: undefined } | { command?: undefined; ru: string } {
  if (UNSAFE.test(root)) return { ru: UNSAFE_RU };
  return { command: `node bin/hub.js init '${root.replace(/'/g, "''")}' --add skill/autopilot --yes` };
}

/** `ready[agent]`: installed, signed in (from the adapter status, never from a credential file) and not at its limit. */
export type Ready = Partial<Record<AgentId, boolean>>;
export interface ModeReviewer { agent: AgentId; model?: string; effort: string; note: string; /** the run's warn event, when the pick is not what the mode promises */ warn?: string }

/**
 * The mode's own reviewer choice (`reviewer` data): `prefer` when it is ready, else `fallback`, else a plain refusal. When the caller says who wrote
 * the change (`implementedBy`) the other vendor is taken if it is ready; the same one only when it is the only one left, and then `warn` says the
 * review is not cross-vendor. Nothing here changes the permission: the caller still passes the request through `applyWorkMode`, which keeps review
 * at `plan`. Claude is Opus; Codex keeps the account's default model (no model id is guessed). `undefined` for a mode with no reviewer data.
 */
export function pickModeReviewer(m: WorkMode, ready: Ready, o: { implementedBy?: AgentId } = {}): ModeReviewer | undefined {
  if (!m.reviewer) return undefined;
  const who = (a: AgentId): string => (a === 'codex' ? 'Codex' : 'Claude');
  const label = (a: AgentId): string => (a === 'codex' ? 'Codex' : 'Opus');
  const mk = (a: AgentId, note: string, warn?: string): ModeReviewer => ({ agent: a, ...(a === 'claude' ? { model: MODEL_ID.opus } : {}), effort: 'high', note, ...(warn ? { warn } : {}) });
  const ok = [m.reviewer.prefer, m.reviewer.fallback].filter((a, i, all) => all.indexOf(a) === i && ready[a]);
  const first = ok[0];
  if (!first) throw new Error(`${m.title} needs a signed-in agent that is under its limit: sign in to Codex or Claude, or wait for the limit to reset (Войдите в Codex или Claude либо дождитесь сброса лимита, чтобы запустить ревью)`);
  const by = o.implementedBy;
  if (by) {
    const other = ok.find((a) => a !== by);
    if (other) return mk(other, `${who(by)} wrote the change, so ${label(other)} reviews, read-only`);
    return mk(first, `only ${label(first)} is available and it is the one that wrote the change; it reviews, read-only`, `${who(by)} wrote this change and only ${label(first)} can review it now: the review is not cross-vendor`);
  }
  return mk(first, first === m.reviewer.prefer ? `${label(first)} is signed in and under its limit: it reviews, read-only` : `${who(m.reviewer.prefer)} is not available (not signed in or at its limit): ${label(first)} reviews, read-only`);
}

/** Turns a work mode and a request into the request the runner takes. Throws a plain message when the mode cannot work here. */
export function applyWorkMode(m: WorkMode, req: StartReq, o: ApplyOpts = {}): StartReq {
  let prompt = req.prompt;
  if (m.autopilot) {
    if (req.agent !== 'claude') throw new WorkModeError('autopilot works with Claude only', 'Автопилот работает только с Claude');
    const st = skillState('claude', req.projectRoot, 'autopilot', o);
    if (st !== 'linked') {
      const fix = autopilotFix(req.projectRoot);
      if (fix.command === undefined) throw new WorkModeError('the autopilot skill is not linked to Claude here, and the project path has characters that cannot be pasted into a command safely: install the autopilot skill in Tools and link it by hand in the Start window', fix.ru);
      if (st === 'in-library') throw new WorkModeError('autopilot is in your hub library but not linked to Claude in this project. Link it (PowerShell, in the Agent Hub folder)', 'Навык autopilot есть в библиотеке, но не подключён к проекту: подключите его командой для PowerShell в папке Agent Hub (она показана отдельной строкой)', fix.command);
      throw new WorkModeError('install the autopilot skill in Tools, then link it (PowerShell, in the Agent Hub folder)', 'Установите навык autopilot во вкладке «Инструменты», затем подключите его командой для PowerShell в папке Agent Hub (она показана отдельной строкой)', fix.command);
    }
    prompt = `/autopilot ${m.autopilot.mode} ${m.autopilot.depth} ${prompt}`;
  } else {
    if (m.promptPrefix) prompt = m.promptPrefix + prompt;
    // optional skills: only Claude takes a slash command here; a missing one is not an error (leanPlan says so in the run)
    const first = req.agent === 'claude' ? (m.skillsIfLinked ?? []).find((n) => trustedSkillLinked(req.projectRoot, n, o.home ?? homedir(), o.hubRoots)) : undefined;
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
