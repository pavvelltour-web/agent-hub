import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { HUB_HOME, loadUserConfig } from '../core/registry.ts';
import { GUARDRAILS_FILE, fileState, guardrailsConfigTrusted, recordTamper, sealThenRename } from './integrity.ts';
import { weighted } from '../econ/econ.ts';
import type { Db } from '../history/store.ts';
import { pathKey } from '../lib/paths.ts';
import type { StartReq } from './runner.ts';

/**
 * Guardrails, the circuit breaker (Phase 7.5, ADR-026). Runaway protection that STOPS runs and says why: one run over a token or cost cap, a day over its caps, the same failure again
 * and again, a continuation chain that keeps growing, runs stopped over and over. ON by default with conservative numbers.
 * Who can change it: only the user's own global config (`guardrails` in `<hub home>/config.json`, written by `POST /api/guardrails`, which needs a request from the panel's own code). A project's `hub.json` may only
 * TIGHTEN a cap (the smaller number wins) and can never switch the protection off or raise a number; a request body to any run route is never read for it. The state is derived from the
 * run table (nothing to get out of sync) plus the user's acknowledgements. `evaluate` is pure (clock and rows are arguments), so tests use no timers.
 */
export interface Caps { enabled: boolean; runWeighted: number; runUsd: number; dayWeighted: number; dayUsd: number; sameFailureN: number; chainMax: number; stopsN: number }
type NumKey = Exclude<keyof Caps, 'enabled'>;
/**
 * The author's numbers, NOT measurements. Weighted Mtok = uncached + 0.1 x cached + 5 x output (econ `weighted`): the default token profile's p90 is about 5 of them and its median
 * 0.7, so a run cap of 25 is about five times a heavy run, a day cap of 120 about twenty-three of them. Dollars are API-equivalent (a subscription is not billed that way): 40 per run, 150 per day.
 */
export const DEFAULT_CAPS: Caps = { enabled: true, runWeighted: 25, runUsd: 40, dayWeighted: 120, dayUsd: 150, sameFailureN: 3, chainMax: 6, stopsN: 4 };
/** What `POST /api/guardrails` accepts per cap (the ceiling is 3 times the default: loosening further than that is not something one click should do): a number outside is refused, not clamped; the stored config is clamped into it when read (a hand-edited file cannot lift a cap past the ceiling). */
export const CAP_RANGE: Record<NumKey, [number, number]> = { runWeighted: [1, 75], runUsd: [1, 120], dayWeighted: [1, 360], dayUsd: [1, 450], sameFailureN: [2, 9], chainMax: [2, 18], stopsN: [2, 12] };
export const NUM_KEYS = Object.keys(CAP_RANGE) as NumKey[];
const WHOLE: ReadonlySet<NumKey> = new Set(['sameFailureN', 'chainMax', 'stopsN']);
/** The same failure within this long of the last one still blocks new starts in that project; the user can acknowledge it earlier. */
export const FAILURE_COOLDOWN_MS = 30 * 60_000;
export const STOPS_WINDOW_MS = 60 * 60_000;
export const DAY_MS = 86_400_000;
const FACT_WINDOW_MS = 3 * DAY_MS;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Numbers only, each clamped into its range (whole ones rounded down); everything else is dropped. Never throws. */
export function sanitizeCaps(raw: unknown): Partial<Record<NumKey, number>> {
  const out: Partial<Record<NumKey, number>> = {};
  if (!isObj(raw)) return out;
  for (const k of NUM_KEYS) { const v = raw[k]; if (fin(v)) { const [lo, hi] = CAP_RANGE[k]; out[k] = Math.min(hi, Math.max(lo, WHOLE.has(k) ? Math.floor(v) : v)); } }
  return out;
}
/** Is this body a legal set of caps? Returns the problem or null. The route refuses an out-of-range number instead of clamping, so the user sees what was not accepted. */
export function capsProblem(raw: unknown): string | null {
  if (!isObj(raw)) return 'caps must be an object';
  for (const [k, v] of Object.entries(raw)) {
    if (!(NUM_KEYS as string[]).includes(k)) return `unknown cap: ${k.slice(0, 40)}`;
    const [lo, hi] = CAP_RANGE[k as NumKey];
    if (!fin(v) || v < lo || v > hi || (WHOLE.has(k as NumKey) && !Number.isInteger(v))) return `${k} must be ${WHOLE.has(k as NumKey) ? 'a whole number' : 'a number'} from ${lo} to ${hi}`;
  }
  return null;
}

/**
 * The caps in force for a project: defaults, then the user's global values, then the project's `hub.json` values where they are SMALLER. `enabled` is the user's alone: only the
 * boolean `false` in the GLOBAL config turns the protection off. `notes` names what a project asked for and did not get.
 */
export function effectiveCaps(userRaw: unknown, projectRaw?: unknown): { caps: Caps; notes: string[] } {
  const g = sanitizeCaps(userRaw), notes: string[] = [];
  const caps: Caps = { ...DEFAULT_CAPS, ...g, enabled: !(isObj(userRaw) && userRaw['enabled'] === false) };
  if (isObj(projectRaw)) {
    const p = sanitizeCaps(projectRaw);
    for (const k of NUM_KEYS) { const v = p[k]; if (v === undefined) continue; if (v < caps[k]) caps[k] = v; else if (v > caps[k]) notes.push(`hub.json просит ${k} = ${v}, но выше ваших ${caps[k]} нельзя: оставлено ${caps[k]}`); }
    if (projectRaw['enabled'] !== undefined) notes.push('hub.json не может включать или выключать защиту: это только ваша настройка');
  }
  return { caps, notes };
}

/** `guardrails` of a project's hub.json (an object or undefined). hub.json can come from a cloned repository: size-capped, never a link, never trusted for more than tightening. */
export function readProjectCaps(root: string): unknown {
  try {
    const p = join(root, 'hub.json'), st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 200_000) return undefined;
    const v = (JSON.parse(readFileSync(p, 'utf8')) as { guardrails?: unknown }).guardrails;
    return isObj(v) ? v : undefined;
  } catch { return undefined; }
}
/**
 * The user's own caps, but only the ones the hub's route saved (their hash is sealed, integrity.ts). Anything else in `guardrails` (an unattended agent or a hand edit changed it)
 * is IGNORED: the defaults apply, so a change that would switch the protection off leaves it ON, and the change is recorded and shown until the user resets.
 */
export const userCapsRaw = (): unknown => {
  const g = (loadUserConfig() as { guardrails?: unknown }).guardrails;
  if (guardrailsConfigTrusted(HUB_HOME, g)) return g;
  recordTamper(HUB_HOME, GUARDRAILS_FILE);
  return undefined;
};

// ---------- facts from the run table ----------
export interface Fact { id: string; projectId: number | null; startedMs: number; endedMs: number | null; outcome: string | null; w: number; usd: number | null; sig: string; handoffOf: string | null }
const signature = (e: string | null): string => {
  const s = (e ?? '').toLowerCase().replace(/[a-z]:[\\/][^\s'"]*|\/[^\s'"]+/g, '<path>').replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || '(без текста)';
};
export function readFacts(db: Db, now: number): Fact[] {
  const rows = db.prepare('SELECT id, project_id AS pid, started_at AS s, ended_at AS e, outcome, tokens_in AS tin, tokens_cached AS tc, tokens_out AS tout, cost_usd AS cost, error, handoff_of AS parent FROM run WHERE started_at >= ? OR outcome IS NULL ORDER BY started_at DESC LIMIT 3000')
    .all(new Date(now - FACT_WINDOW_MS).toISOString()) as unknown as { id: string; pid: number | null; s: string; e: string | null; outcome: string | null; tin: number | null; tc: number | null; tout: number | null; cost: number | null; error: string | null; parent: string | null }[];
  return rows.map((r) => {
    const cached = r.tc ?? 0, t = Date.parse(r.s), te = r.e ? Date.parse(r.e) : NaN;
    return { id: r.id, projectId: r.pid, startedMs: Number.isFinite(t) ? t : 0, endedMs: Number.isFinite(te) ? te : null, outcome: r.outcome, w: weighted({ uncachedIn: Math.max(0, (r.tin ?? 0) - cached), cachedIn: cached, out: r.tout ?? 0 }), usd: fin(r.cost) && r.cost >= 0 ? r.cost : null, sig: r.outcome === 'guard' ? '(остановлено защитой)' : signature(r.error), handoffOf: r.parent };
  });
}

// ---------- the pure evaluation ----------
export type TripKind = 'run-cap' | 'day-cap' | 'same-failure' | 'chain' | 'repeated-stops';
export interface Trip { kind: TripKind; key: string; ru: string; /** stops new starts (in `projectId`, or everywhere when absent) */ blocksStart: boolean; /** live runs to stop */ stop: string[]; projectId?: number; /** the user can acknowledge it (the facts before the acknowledgement are ignored) */ ackable: boolean }
const mw = (x: number): string => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)).replace('.', ',');
/** Does one run (live numbers) pass the per-run caps? A reason or null. */
export function runOver(caps: Caps, w: number, usd: number | null): string | null {
  if (!caps.enabled) return null;
  if (w > caps.runWeighted) return `запуск израсходовал ${mw(w)} условных млн токенов при пороге ${mw(caps.runWeighted)}`;
  if (usd != null && usd > caps.runUsd) return `запуск стоит уже $${Math.round(usd)} по ценам API при пороге $${Math.round(caps.runUsd)}`;
  return null;
}
/** Depth of a continuation chain: the number of runs behind this one (cycles and absurd lengths are cut). */
export function chainDepth(facts: Fact[], handoffOf: string | null | undefined): number {
  const by = new Map(facts.map((f) => [f.id, f]));
  let n = 0;
  for (let id = handoffOf ?? null, seen = new Set<string>(); id && n < 50 && !seen.has(id); n++) { seen.add(id); id = by.get(id)?.handoffOf ?? null; }
  return n;
}

/** A failed run, or one the circuit breaker itself stopped: both are the model going wrong, and a runaway must not become invisible by being stopped. */
const isFail = (f: Fact): boolean => f.outcome === 'failed' || f.outcome === 'guard';

export function evaluate(o: { now: number; facts: Fact[]; caps: Caps; acks?: Record<string, number>; start?: { handoffOf?: string | null } }): Trip[] {
  const { now, facts, caps } = o, acks = o.acks ?? {}, trips: Trip[] = [];
  if (!caps.enabled) return trips;
  const live = facts.filter((f) => f.outcome === null);
  for (const f of live) { const why = runOver(caps, f.w, f.usd); if (why) trips.push({ kind: 'run-cap', key: `run-cap:${f.id}`, ru: why, blocksStart: false, stop: [f.id], ackable: false }); }
  const day = facts.filter((f) => now - f.startedMs < DAY_MS);
  const dw = day.reduce((a, f) => a + f.w, 0), du = day.reduce((a, f) => a + (f.usd ?? 0), 0);
  if (dw > caps.dayWeighted) trips.push({ kind: 'day-cap', key: 'day-cap', ru: `за сутки израсходовано ${mw(dw)} условных млн токенов при пороге ${mw(caps.dayWeighted)}: новые запуски остановлены, пока сутки не пройдут`, blocksStart: true, stop: live.map((f) => f.id), ackable: false });
  else if (du > caps.dayUsd) trips.push({ kind: 'day-cap', key: 'day-cap', ru: `за сутки набежало $${Math.round(du)} по ценам API при пороге $${Math.round(caps.dayUsd)}: новые запуски остановлены, пока сутки не пройдут`, blocksStart: true, stop: live.map((f) => f.id), ackable: false });
  const byProject = new Map<number, Fact[]>();
  for (const f of facts) if (f.projectId != null) byProject.set(f.projectId, [...(byProject.get(f.projectId) ?? []), f]);
  for (const [pid, fs] of byProject) {
    const keyF = `same-failure:${pid}`, keyS = `repeated-stops:${pid}`;
    const done = fs.filter((f) => f.endedMs !== null && f.outcome !== null && f.outcome !== 'interrupted' && f.outcome !== 'stopped' && f.outcome !== 'guard-stop' && (f.endedMs as number) > (acks[keyF] ?? 0)).sort((a, b) => (b.endedMs as number) - (a.endedMs as number));
    const newest = done[0];
    if (newest && isFail(newest) && now - (newest.endedMs as number) < FAILURE_COOLDOWN_MS) {
      let n = 0;
      for (const f of done) { if (!isFail(f) || f.sig !== newest.sig) break; n++; }
      if (n >= caps.sameFailureN) trips.push({ kind: 'same-failure', key: keyF, ru: `одна и та же ошибка ${n} раза подряд («${newest.sig.slice(0, 60)}»): запуски в этом проекте остановлены, пока вы не посмотрите, что случилось`, blocksStart: true, stop: [], projectId: pid, ackable: true });
    }
    const stops = fs.filter((f) => (f.outcome === 'context' || f.outcome === 'limit' || f.outcome === 'guard') && f.endedMs !== null && now - (f.endedMs as number) < STOPS_WINDOW_MS && (f.endedMs as number) > (acks[keyS] ?? 0));
    if (stops.length >= caps.stopsN) trips.push({ kind: 'repeated-stops', key: keyS, ru: `${stops.length} остановок за час из-за контекста или лимита: запуски в этом проекте остановлены, пока вы не посмотрите, что происходит`, blocksStart: true, stop: [], projectId: pid, ackable: true });
  }
  for (const f of live) { const d = chainDepth(facts, f.handoffOf); if (f.handoffOf && d + 1 > caps.chainMax) trips.push({ kind: 'chain', key: `chain:${f.id}`, ru: `цепочка продолжений дошла до ${d + 1} запусков подряд (порог ${caps.chainMax}): остановлено`, blocksStart: false, stop: [f.id], ackable: false }); }
  if (o.start && o.start.handoffOf) { const d = chainDepth(facts, o.start.handoffOf); if (d + 1 > caps.chainMax) trips.push({ kind: 'chain', key: `chain:start`, ru: `цепочка продолжений уже из ${d + 1} запусков (порог ${caps.chainMax}): новое продолжение не начато`, blocksStart: true, stop: [], ackable: false }); }
  return trips;
}

// ---------- acknowledgements (the user's click) ----------
const ACK_KEY = /^(same-failure|repeated-stops):\d{1,9}$/;
const ackFile = (home: string): string => join(home, 'guardrails.json');
export function loadAcks(home: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (fileState(home, 'guardrails.json') === 'changed') { recordTamper(home, 'guardrails.json'); return out; }   // forged acknowledgements clear nothing
  try {
    if (statSync(ackFile(home)).size > 100_000) return out;
    const raw = JSON.parse(readFileSync(ackFile(home), 'utf8')) as { acks?: unknown };
    if (isObj(raw.acks)) for (const [k, v] of Object.entries(raw.acks).slice(0, 500)) if (ACK_KEY.test(k) && fin(v) && v > 0) out[k] = v;
  } catch { /* no acknowledgements */ }
  return out;
}
/** The user looked at a trip that can be acknowledged: facts up to now no longer count for it. Only `same-failure` and `repeated-stops` can be (a cap cannot be waved away). */
export function ackTrip(home: string, key: string, now: number): boolean {
  if (!ACK_KEY.test(key)) return false;
  const acks = loadAcks(home); acks[key] = now;
  mkdirSync(home, { recursive: true });
  const f = ackFile(home), tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ acks }), 'utf8'); sealThenRename(home, 'guardrails.json', tmp); void f;
  return true;
}
/** An append-only line for every change of the protection itself (who: the panel; what; when). */
export function auditGuard(home: string, e: Record<string, unknown>): void {
  try { mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'guardrails-audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); } catch { /* best effort */ }
}

// ---------- the guard the RunManager asks ----------
export interface RunGuard {
  /** A reason (Russian, shown to the user) when this run must not start, else null. */
  start?: (req: StartReq) => string | null;
  /**
   * Called with the live totals of a run: a reason when it must be stopped now, else null. A plain string means THIS RUN is the runaway (outcome `guard`: a failure for quality).
   * `{ reason, neutral: true }` is a stop for a SHARED limit (the day, a continuation chain): the run did nothing wrong, so its outcome is `guard-stop` and it scores nothing.
   */
  usage?: (i: { runId: string; projectRoot: string; weighted: number; costUsd: number | null }) => string | { reason: string; neutral: true } | null;
}
export interface GuardOpts { db: Db; home: string; now?: () => number; userCaps?: () => unknown; projectCaps?: (root: string) => unknown }

/** Trips that stop new starts in this folder now (for the scheduler and the status route). */
export function blockingTrips(db: Db, home: string, root: string | null, o: { now?: number; userCaps?: unknown; projectCaps?: unknown } = {}): Trip[] {
  const now = o.now ?? Date.now(), { caps } = effectiveCaps(o.userCaps === undefined ? userCapsRaw() : o.userCaps, o.projectCaps === undefined && root ? readProjectCaps(root) : o.projectCaps);
  const pid = root ? (db.prepare('SELECT id FROM project WHERE key = ?').get(pathKey(root)) as { id: number } | undefined)?.id : undefined;
  return evaluate({ now, facts: readFacts(db, now), caps, acks: loadAcks(home) }).filter((t) => t.blocksStart && (t.projectId == null || t.projectId === pid));
}

/** The guard of a RunManager. ON unless the user's own config says `enabled: false`. */
export function makeGuard(o: GuardOpts): RunGuard {
  const clock = o.now ?? Date.now, userCaps = o.userCaps ?? userCapsRaw, projectCaps = o.projectCaps ?? readProjectCaps;
  let cache: { at: number; facts: Fact[] } | undefined;
  const facts = (now: number): Fact[] => { if (!cache || now - cache.at > 5000) cache = { at: now, facts: readFacts(o.db, now) }; return cache.facts; };
  const capsFor = (root: string): Caps => effectiveCaps(userCaps(), projectCaps(root)).caps;
  return {
    start: (req) => {
      const now = clock(), caps = capsFor(req.projectRoot);
      if (!caps.enabled) return null;
      const pid = (o.db.prepare('SELECT id FROM project WHERE key = ?').get(pathKey(req.projectRoot)) as { id: number } | undefined)?.id;
      const trip = evaluate({ now, facts: readFacts(o.db, now), caps, acks: loadAcks(o.home), start: { handoffOf: req.handoffOf ?? null } }).find((t) => t.blocksStart && (t.projectId == null || t.projectId === pid));
      return trip ? `Защита от лишних запусков: ${trip.ru}` : null;
    },
    usage: (i) => {
      const now = clock(), caps = capsFor(i.projectRoot);
      if (!caps.enabled) return null;
      const one = runOver(caps, i.weighted, i.costUsd);
      if (one) return one;
      // a continuation chain that grew past the cap is stopped here too (the trip list alone only describes it)
      const parent = (o.db.prepare('SELECT handoff_of AS p FROM run WHERE id = ?').get(i.runId) as { p: string | null } | undefined)?.p;
      if (parent) { const d = chainDepth(facts(now), parent); if (d + 1 > caps.chainMax) return { reason: `цепочка продолжений дошла до ${d + 1} запусков подряд при пороге ${caps.chainMax}`, neutral: true }; }
      const others = facts(now).filter((f) => f.id !== i.runId && now - f.startedMs < DAY_MS);
      const dw = others.reduce((a, f) => a + f.w, 0) + i.weighted, du = others.reduce((a, f) => a + (f.usd ?? 0), 0) + (i.costUsd ?? 0);
      if (dw > caps.dayWeighted) return { reason: `за сутки израсходовано ${mw(dw)} условных млн токенов при пороге ${mw(caps.dayWeighted)}`, neutral: true };
      if (du > caps.dayUsd) return { reason: `за сутки набежало $${Math.round(du)} по ценам API при пороге $${Math.round(caps.dayUsd)}`, neutral: true };
      return null;
    },
  };
}
void existsSync;
