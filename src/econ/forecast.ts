import type { AgentId } from '../core/types.ts';
import { classify } from './classify.ts';
import { costUsd, DEFAULT_PROFILE, weighted, type Calib, type OutcomeRow } from './econ.ts';
import { agentOf, modelKey, PRIOR, type TaskClass } from './router.ts';

/**
 * Project forecast (Phase 7.3): what the open tasks of a project will take, as RANGES, from the user's own finished runs.
 * Pure computation over stored data; nothing is invented. Every number carries a label:
 *   measured  = every input of it comes from the user's own history (token use, success, limit calibration, cost);
 *   estimated = at least one input is a prior or a default (the wide default token profile, the author's success beliefs, the Codex limit prior, the price table);
 *   unknown   = it is not given at all (a missing number is `undefined`/`null`, never 0).
 * Below MIN_SETTLED finished runs the answer is «недостаточно данных» and no number at all.
 *
 * Monte Carlo (seeded, so the same data gives the same answer): per trial, per class a shared draw of the class's mean (the parameter uncertainty: it shrinks with 1/sqrt(n),
 * so more history narrows the range), then per task a log-normal draw of the weighted tokens; success from the run score of that class; a failed task adds another run (a cascade rung), at most MAX_RETRIES.
 * Weighted tokens become a share of the weekly limit through the calibration range (uniform between its low and high), dollars through the measured cost per weighted token.
 */
export type Label = 'measured' | 'estimated' | 'unknown';
export interface Range { p50: number; p90: number; label: Label }
export type Basis = 'measured' | 'mixed' | 'estimated';
export interface RunSample { cls: TaskClass; agent: AgentId; mw: number; score: number | null; costUsd: number | null }
export interface LimitIn { usedPercent: number | null; reached: boolean; resetsAt?: number | null; windowMinutes?: number | null }
export interface ForecastIn {
  tasks: { title: string; cls: TaskClass }[]; history: OutcomeRow[]; samples?: RunSample[];
  limits: Partial<Record<AgentId, LimitIn>>; calib: Record<AgentId, Calib>;
  /** The router's pick for a class: which agent and model would run it. */
  route: (cls: TaskClass) => { agent: AgentId; model: string };
  trials?: number; seed?: number; now?: number;
}
export interface ClassInfo { cls: TaskClass; tasks: number; n: number; label: Label; agent: AgentId }
export interface Forecast {
  enough: boolean; reason: string | null; tasks: number;
  limitPct: Partial<Record<AgentId, Range>>; weeks: Range | null; usd: Range | null; risk: string[]; basis: Basis; classes: ClassInfo[];
}

/** Finished runs (done or failed) needed before any forecast is shown. */
export const MIN_SETTLED = 5;
/** Runs of one class and agent before its own distribution is trusted (the same bar as the router's MIN_RUNS). */
export const MIN_CLASS_SAMPLES = 3;
export const MAX_TASKS = 500;
const MAX_RETRIES = 2, WEEK_SEC = 7 * 86400, MAX_WORK = 400_000, MAX_MW = 1e5;
const CLASSES: readonly TaskClass[] = ['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary'];
const isClass = (x: unknown): x is TaskClass => typeof x === 'string' && (CLASSES as readonly string[]).includes(x);
export const CLASS_RU: Record<TaskClass, string> = { plan: 'планирование', critical_adr: 'важные решения', implement: 'реализация', debug: 'отладка', review: 'ревью', mechanical: 'рутина', summary: 'пересказ' };
const AGENT_RU: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };

/** Spread of the default token profile (log-normal sigma from its p50 and p90): the width of "we know nothing about this class". */
const PRIOR_SIGMA = Math.log(weighted(DEFAULT_PROFILE.p90) / weighted(DEFAULT_PROFILE.p50)) / 1.2816;
const SIGMA_FLOOR = 0.15;

// ---------- seeded random numbers ----------
function mulberry32(seed: number): () => number {
  let a = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const normal = (rnd: () => number): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const at = (sorted: Float64Array, p: number): number => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number) : 0);

// ---------- tasks.md ----------
export interface ParsedTasks { tasks: { title: string; cls: TaskClass; guessed: boolean }[]; done: number; guessed: number; truncated: boolean }
const MAX_MD = 256 * 1024, MAX_TITLE = 300;
const TRAIL = new RegExp(`\\s*\\[(${CLASSES.join('|')})\\]\\s*$`, 'i');
const LEAD = /^(?:T\d{1,4}\s+)?/;
/**
 * Open checkboxes of a tasks file: `- [ ] <title> [class]`. The class is the trailing [bracket] when it names one; otherwise it is read from the text (a guess, counted in `guessed`).
 * Spec Kit's leading `T004`, `[P]`, `[US1]` are not part of the title. Done boxes are counted, not forecast. Headings are structure, not tasks. A file over 256 KB is ignored.
 */
export function parseTasks(md: string): ParsedTasks {
  const out: ParsedTasks = { tasks: [], done: 0, guessed: 0, truncated: false };
  if (typeof md !== 'string' || md.length > MAX_MD) return out;
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] !== ' ') { out.done++; continue; }
    if (out.tasks.length >= MAX_TASKS) { out.truncated = true; break; }
    let text = (m[2] as string).replace(LEAD, '');
    let cls: TaskClass | undefined;
    const trail = TRAIL.exec(text);
    if (trail) { cls = trail[1]!.toLowerCase() as TaskClass; text = text.slice(0, trail.index); }
    for (let tag = /^\[([A-Za-z0-9_-]{1,12})\]\s*/.exec(text); tag; tag = /^\[([A-Za-z0-9_-]{1,12})\]\s*/.exec(text)) { if (!cls && isClass(tag[1]!.toLowerCase())) cls = tag[1]!.toLowerCase() as TaskClass; text = text.slice(tag[0].length); }
    const title = text.trim().slice(0, MAX_TITLE);
    if (!title) continue;
    const guessed = !cls;
    if (guessed) out.guessed++;
    out.tasks.push({ title, cls: cls ?? classify(title).cls, guessed });
  }
  return out;
}

// ---------- the model of one (class, agent) ----------
interface ClassModel { cls: TaskClass; agent: AgentId; model: string; n: number; label: Label; m: number; s: number; paramSd: number; pSuccess: number; usdPerMw: number | null; usdMeasured: boolean }

function modelFor(cls: TaskClass, pick: { agent: AgentId; model: string }, samples: RunSample[], history: OutcomeRow[]): ClassModel {
  const mine = samples.filter((s) => s.cls === cls && s.agent === pick.agent && Number.isFinite(s.mw) && s.mw > 0 && s.mw <= MAX_MW);
  const rows = history.filter((r) => r.cls === cls && agentOf(modelKey(r.model)) === pick.agent);
  let m: number, s: number, paramSd: number, tokensMeasured = false;
  const n = mine.length;
  if (n >= MIN_CLASS_SAMPLES) {
    const xs = mine.map((x) => Math.log(x.mw)), mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    m = mean; s = Math.max(sd, SIGMA_FLOOR); paramSd = s / Math.sqrt(n); tokensMeasured = true;
  } else {
    const known = rows.filter((r) => Number.isFinite(r.actualMw) && r.actualMw > 0 && r.actualMw <= MAX_MW);
    const runs = known.reduce((a, r) => a + Math.max(1, r.runs), 0);
    if (known.length) { const mean = known.reduce((a, r) => a + r.actualMw * Math.max(1, r.runs), 0) / runs; s = PRIOR_SIGMA; m = Math.log(mean) - s * s / 2; paramSd = s / Math.sqrt(runs); }
    else { s = PRIOR_SIGMA; m = Math.log(weighted(DEFAULT_PROFILE.p50)); paramSd = s; }
  }
  // success: the user's run scores of this class and agent, else the rows' done/failed, else the author's prior belief
  const scored = mine.filter((x) => x.score != null && Number.isFinite(x.score));
  let p: number, pMeasured = false;
  const settled = rows.reduce((a, r) => a + r.done + r.failed, 0);
  if (scored.length >= MIN_CLASS_SAMPLES) { p = scored.reduce((a, x) => a + (x.score as number), 0) / scored.length; pMeasured = true; }
  else if (settled >= MIN_CLASS_SAMPLES) { p = rows.reduce((a, r) => a + r.done, 0) / settled; pMeasured = true; }
  else p = PRIOR[cls][modelKey(pick.model)];
  const pSuccess = Math.min(0.98, Math.max(0.02, Number.isFinite(p) ? p : 0.5));
  // dollars per weighted Mtok: measured from runs that recorded a cost, else the price table at the default profile, else unknown
  const costed = mine.filter((x) => x.costUsd != null && Number.isFinite(x.costUsd) && (x.costUsd as number) >= 0);
  let usdPerMw: number | null = null, usdMeasured = false;
  if (costed.length >= MIN_CLASS_SAMPLES) { usdPerMw = costed.reduce((a, x) => a + (x.costUsd as number), 0) / costed.reduce((a, x) => a + x.mw, 0); usdMeasured = true; }
  else { const c = costUsd(pick.model, DEFAULT_PROFILE.p50); usdPerMw = c == null ? null : c / weighted(DEFAULT_PROFILE.p50); }
  return { cls, agent: pick.agent, model: pick.model, n, label: tokensMeasured && pMeasured ? 'measured' : 'estimated', m, s, paramSd, pSuccess, usdPerMw, usdMeasured };
}

/** Weeks of the weekly limit the work needs: 0 while it fits in what is left of this window, else the days to the reset plus the rest at one full window per week. */
function weeksFor(pct: number, lim: LimitIn | undefined, nowSec: number): number {
  const left = lim?.usedPercent != null && Number.isFinite(lim.usedPercent) ? Math.max(0, 100 - lim.usedPercent) : null;
  if (left == null) return pct / 100;
  if (pct <= left) return 0;
  const toReset = lim?.resetsAt != null && Number.isFinite(lim.resetsAt) ? Math.max(0, lim.resetsAt - nowSec) / WEEK_SEC : 0;
  return toReset + (pct - left) / 100;
}

const round = (x: number, d: number): number => { const k = 10 ** d; return Math.round(x * k) / k; };
const usable = (c: Calib | undefined): c is Calib => !!c && c.source !== 'none' && Number.isFinite(c.lowMwPerPct) && Number.isFinite(c.highMwPerPct) && c.lowMwPerPct > 0 && c.highMwPerPct >= c.lowMwPerPct;

export function forecast(o: ForecastIn): Forecast {
  const tasks = (Array.isArray(o.tasks) ? o.tasks : []).slice(0, MAX_TASKS).map((t) => ({ title: t?.title, cls: isClass(t?.cls) ? t.cls : ('implement' as TaskClass) }));
  const history = Array.isArray(o.history) ? o.history : [], samples = Array.isArray(o.samples) ? o.samples : [];
  const empty: Forecast = { enough: true, reason: null, tasks: 0, limitPct: {}, weeks: null, usd: null, risk: [], basis: 'measured', classes: [] };
  if (!tasks.length) {
    // nothing left to do: zeros are exact, for every agent whose limit can be calibrated
    const z: Range = { p50: 0, p90: 0, label: 'measured' };
    return { ...empty, limitPct: Object.fromEntries((['claude', 'codex'] as AgentId[]).filter((a) => usable(o.calib?.[a])).map((a) => [a, { ...z }])), weeks: { ...z }, usd: { ...z } };
  }
  const settled = Math.max(history.reduce((a, r) => a + (r.done || 0) + (r.failed || 0), 0), samples.length);
  if (settled < MIN_SETTLED) return { ...empty, enough: false, reason: 'недостаточно данных', tasks: tasks.length, basis: 'estimated' };

  const nowSec = (Number.isFinite(o.now) ? (o.now as number) : Date.now()) / 1000;
  const route = new Map<TaskClass, ClassModel>();
  const counts = new Map<TaskClass, number>();
  for (const t of tasks) counts.set(t.cls, (counts.get(t.cls) ?? 0) + 1);
  for (const cls of counts.keys()) { const pick = o.route(cls); route.set(cls, modelFor(cls, pick, samples, history)); }
  const agents = [...new Set([...route.values()].map((c) => c.agent))];
  const trials = Math.max(200, Math.min(5000, Math.floor(Number.isFinite(o.trials) ? (o.trials as number) : 2000), Math.floor(MAX_WORK / tasks.length)));
  const rnd = mulberry32(o.seed ?? 1);

  const mw: Record<string, Float64Array> = Object.fromEntries(agents.map((a) => [a, new Float64Array(trials)]));
  const usdTrial = new Float64Array(trials);
  const usdKnown = [...route.values()].every((c) => c.usdPerMw != null);
  const mwPerPct: Record<string, { lo: number; hi: number } | undefined> = Object.fromEntries(agents.map((a) => [a, usable(o.calib?.[a]) ? { lo: o.calib[a].lowMwPerPct, hi: o.calib[a].highMwPerPct } : undefined]));
  const pct: Record<string, Float64Array> = Object.fromEntries(agents.map((a) => [a, new Float64Array(trials)]));
  const weeksTrial = new Float64Array(trials);
  const weekly = agents.filter((a) => mwPerPct[a] && !(o.limits?.[a]?.windowMinutes != null && (o.limits[a]?.windowMinutes as number) < 6 * 1440));

  for (let t = 0; t < trials; t++) {
    const mu = new Map<TaskClass, number>();
    for (const c of route.values()) mu.set(c.cls, c.m + c.paramSd * normal(rnd));
    for (const task of tasks) {
      const c = route.get(task.cls) as ClassModel;
      for (let run = 0; run <= MAX_RETRIES; run++) {
        const w = Math.exp((mu.get(c.cls) as number) + c.s * normal(rnd));
        const acc = mw[c.agent] as Float64Array;
        acc[t] = (acc[t] as number) + w;
        if (usdKnown) usdTrial[t] = (usdTrial[t] as number) + w * (c.usdPerMw as number);
        if (rnd() < c.pSuccess) break;
      }
    }
    let wk = 0;
    for (const a of agents) {
      const r = mwPerPct[a];
      if (!r) continue;
      (pct[a] as Float64Array)[t] = (mw[a] as Float64Array)[t]! / (r.lo + (r.hi - r.lo) * rnd());
    }
    for (const a of weekly) wk = Math.max(wk, weeksFor((pct[a] as Float64Array)[t] as number, o.limits?.[a], nowSec));
    weeksTrial[t] = wk;
  }

  const classes: ClassInfo[] = [...route.values()].map((c) => ({ cls: c.cls, tasks: counts.get(c.cls) ?? 0, n: c.n, label: c.label, agent: c.agent }));
  const allMeasured = classes.every((c) => c.label === 'measured'), noneMeasured = classes.every((c) => c.label !== 'measured');
  const basis: Basis = allMeasured ? 'measured' : noneMeasured ? 'estimated' : 'mixed';
  const sorted = (a: Float64Array): Float64Array => Float64Array.from(a).sort();
  const risk: string[] = [];
  risk.push(...classes.filter((c) => c.label !== 'measured').map((c) => `нет данных по задачам типа «${CLASS_RU[c.cls]}» (${c.n} из ${MIN_CLASS_SAMPLES} нужных запусков): взяты средние значения`));
  for (const c of classes.filter((x) => x.label === 'measured' && x.n < 8)) risk.push(`по задачам типа «${CLASS_RU[c.cls]}» мало данных (${c.n} запусков): диапазон широкий`);

  const limitPct: Partial<Record<AgentId, Range>> = {};
  for (const a of agents) {
    if (!mwPerPct[a]) { risk.push(`замеров лимита ${AGENT_RU[a]} нет: доля лимита неизвестна`); continue; }
    const mine = classes.filter((c) => c.agent === a);
    const s = sorted(pct[a] as Float64Array);
    limitPct[a] = { p50: round(at(s, 0.5), 1), p90: round(at(s, 0.9), 1), label: o.calib[a].source === 'measured' && mine.every((c) => c.label === 'measured') ? 'measured' : 'estimated' };
  }
  for (const a of agents) {
    const l = o.limits?.[a];
    if (l?.reached || (l?.usedPercent != null && l.usedPercent >= 95)) risk.push(`лимит ${AGENT_RU[a]} почти исчерпан: ${l?.reached ? 'достигнут' : `использовано ${Math.round(l?.usedPercent ?? 0)} %`}`);
    else if (mwPerPct[a] && l?.usedPercent == null) risk.push(`сколько осталось от лимита ${AGENT_RU[a]}, неизвестно: недели посчитаны по полному окну`);
    if (l?.windowMinutes != null && l.windowMinutes < 6 * 1440) risk.push(`лимит ${AGENT_RU[a]} не недельный (окно ${Math.round(l.windowMinutes / 60)} ч): недели по нему не считаются`);
  }
  let weeks: Range | null = null;
  if (weekly.length) {
    const s = sorted(weeksTrial);
    const knownLeft = weekly.every((a) => o.limits?.[a]?.usedPercent != null);
    weeks = { p50: round(at(s, 0.5), 2), p90: round(at(s, 0.9), 2), label: knownLeft && weekly.every((a) => limitPct[a]?.label === 'measured') ? 'measured' : 'estimated' };
    const skipped = agents.filter((a) => mwPerPct[a] && !weekly.includes(a));
    if (skipped.length) risk.push(`недели посчитаны без ${skipped.map((a) => AGENT_RU[a]).join(' и ')}`);
  }
  let usd: Range | null = null;
  if (usdKnown) { const s = sorted(usdTrial); usd = { p50: round(at(s, 0.5), 2), p90: round(at(s, 0.9), 2), label: [...route.values()].every((c) => c.usdMeasured) && allMeasured ? 'measured' : 'estimated' }; }
  else for (const c of route.values()) if (c.usdPerMw == null) risk.push(`Цена модели ${c.model} не проверена, поэтому доллары не считаются.`);
  return { enough: true, reason: null, tasks: tasks.length, limitPct, weeks, usd, risk: [...new Set(risk)], basis, classes };
}
