import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AgentId } from '../core/types.ts';
import type { Db } from '../history/store.ts';
import { advise, type LimitState } from './advisor.ts';
import { calibrate, canonicalModel, costUsd, effortProfiles, gateRejected, modelStats, NOT_REVIEWER_SQL, outcomes, REVIEW_INFO_SQL, REVIEW_STATE_SQL, runScore, settledOutcome, weighted } from './econ.ts';
import { forecast, parseTasks, type Forecast, type LimitIn, type ParsedTasks, type RunSample } from './forecast.ts';
import { limitSnapshots } from './limits.ts';
import type { TaskClass } from './router.ts';

/** Reads for the forecast: the open tasks of a project folder and the user's own finished runs. Read-only, nothing leaves the folder. */
const MAX_SPECS = 20, MAX_FILE = 256 * 1024;

const readSmall = (root: string, file: string): string | undefined => {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE) return undefined;   // a link or junction could point out of the project
    const rel = relative(realpathSync(root), realpathSync(file));
    if (rel.startsWith('..') || rel.split(sep).includes('..')) return undefined;
    return readFileSync(file, 'utf8');
  } catch { return undefined; }
};

/** `tasks.md` of the folder and `specs/<part>/tasks.md` (at most 20 parts), merged. `files` are relative paths with `/`. */
export function readProjectTasks(root: string): ParsedTasks & { files: string[] } {
  const out: ParsedTasks & { files: string[] } = { tasks: [], done: 0, guessed: 0, truncated: false, files: [] };
  const paths: [string, string][] = [['tasks.md', join(root, 'tasks.md')]];
  try {
    const specs = join(root, 'specs');
    if (lstatSync(specs).isDirectory() && !lstatSync(specs).isSymbolicLink()) for (const d of readdirSync(specs).sort().slice(0, MAX_SPECS)) paths.push([`specs/${d}/tasks.md`, join(specs, d, 'tasks.md')]);
  } catch { /* no specs folder */ }
  for (const [rel, file] of paths) {
    const text = readSmall(root, file);
    if (text === undefined) continue;
    const p = parseTasks(text);
    out.files.push(rel); out.done += p.done; out.guessed += p.guessed; out.truncated ||= p.truncated;
    for (const t of p.tasks) { if (out.tasks.length >= 500) { out.truncated = true; break; } out.tasks.push(t); }
  }
  return out;
}

/** One sample per settled run: weighted Mtok, the run score the router uses, and its cost (own or from the price table). Partial work (limit and context stops) says nothing about what a task costs. */
export function runSamples(db: Db): RunSample[] {
  const rows = db.prepare(`SELECT r.cls, r.agent, r.model, r.outcome, r.rating, r.verify_passed AS verify, ${REVIEW_STATE_SQL} AS rstate, ${REVIEW_INFO_SQL} AS rinfo, r.tokens_in AS tin, r.tokens_cached AS tc, r.tokens_out AS tout, r.cost_usd AS cost FROM run r WHERE r.cls IS NOT NULL AND r.outcome IS NOT NULL AND r.outcome NOT IN ('interrupted', 'context', 'limit') AND ${NOT_REVIEWER_SQL} ORDER BY r.started_at DESC LIMIT 2000`).all() as unknown as { cls: string; agent: string; model: string | null; outcome: string; rating: number | null; verify: number | null; rstate: string | null; rinfo: string | null; tin: number | null; tc: number | null; tout: number | null; cost: number | null }[];
  const out: RunSample[] = [];
  for (const r of rows) {
    const settled = settledOutcome(r.outcome, r.rstate);
    if ((settled !== 'done' && settled !== 'failed') || (r.agent !== 'claude' && r.agent !== 'codex')) continue;
    const cached = r.tc ?? 0, t = { uncachedIn: Math.max(0, (r.tin ?? 0) - cached), cachedIn: cached, out: r.tout ?? 0 };
    const mw = weighted(t);
    if (!(mw > 0)) continue;
    const own = typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost > 0 ? r.cost : null;
    out.push({ cls: r.cls as TaskClass, agent: r.agent, mw, score: runScore(settled, r.rating, r.verify, gateRejected(r.rstate, r.rinfo)), costUsd: own ?? costUsd(canonicalModel(r.model), t) });
  }
  return out;
}

/** What the forecast reads of the limits: the newest snapshot per agent. */
export const forecastLimits = (db: Db, now: number): Partial<Record<AgentId, LimitIn>> => {
  const out: Partial<Record<AgentId, LimitIn>> = {};
  for (const [a, l] of Object.entries(limitSnapshots(db, now)) as [AgentId, NonNullable<ReturnType<typeof limitSnapshots>[AgentId]>][]) out[a] = { usedPercent: l.usedPercent, reached: l.reached, resetsAt: l.resetsAt, windowMinutes: l.windowMinutes };
  return out;
};

/** The whole forecast of a project folder from the database. `seed` fixed: the same data shows the same range each time the page is opened. */
export function projectForecast(db: Db, root: string, o: { now?: number; priceWeight?: number } = {}): { tasks: ParsedTasks & { files: string[]; total: number }; forecast: Forecast; sampleRuns: number } {
  const now = o.now ?? Date.now();
  const parsed = readProjectTasks(root);
  const history = outcomes(db), samples = runSamples(db);
  const limits = forecastLimits(db, now);
  const stats = modelStats(db), profiles = effortProfiles(db);
  const states: Partial<Record<AgentId, LimitState>> = Object.fromEntries(Object.entries(limits).map(([a, l]) => [a, { usedPercent: l.usedPercent, reached: l.reached }]));
  const f = forecast({
    tasks: parsed.tasks.map((t) => ({ title: t.title, cls: t.cls })), history, samples, limits,
    calib: { claude: calibrate(db, 'claude'), codex: calibrate(db, 'codex') },
    route: (cls) => { const c = advise({ cls, limits: states, stats, effortProfiles: profiles, explore: 0, priceWeight: o.priceWeight ?? 1 }); return { agent: c.agent, model: c.model }; },
    now, seed: 20261027,
  });
  return { tasks: { ...parsed, total: parsed.tasks.length + parsed.done }, forecast: f, sampleRuns: samples.length };
}
