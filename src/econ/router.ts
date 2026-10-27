import { costUsd, DEFAULT_PROFILE, type Profile } from './econ.ts';
import type { AgentId } from '../core/types.ts';

/**
 * Picks the model that sits closest to the ideal "top quality at zero price".
 * Every option is a point (quality 0..1, price tier 0..1); distance to the ideal corner is the score. Lower is better.
 *   quality = (5 × prior + sum of observed scores) / (5 + runs)     prior = the author's guess until real runs replace it
 *   price   = cost of the model relative to the most expensive one, for a typical task mix (GPT price unknown → treated as Sonnet)
 * The price weight depends on the kind of work: for plans quality matters most, for rote work price does.
 * An option is a (model, effort) PAIR: effort moves quality by an additive prior delta and price by the output tokens it burns.
 */
export type TaskClass = 'plan' | 'critical_adr' | 'implement' | 'debug' | 'review' | 'mechanical' | 'summary';
export type ModelKey = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'gpt';
/** Reasoning effort of a run. A plain string at the adapter level (`--effort`, `model_reasoning_effort`), so every level is a valid adapter effort. (src/review's `Effort` is review depth, a different thing.) */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export interface Stat { n: number; score: number }              // observed runs and the sum of their scores (0..1 each)
export type ModelStats = Record<string, Stat>;                    // key: `${cls}|${modelKey}`

export const modelKey = (m: string): ModelKey => (/opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : 'gpt');
export const MODEL_ID: Record<Exclude<ModelKey, 'gpt'>, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };
export const agentOf = (k: ModelKey): AgentId => (k === 'gpt' ? 'codex' : 'claude');

/** Author's starting beliefs, NOT measurements: how often this model gets this kind of task right. Real runs take over as they accumulate. */
export const PRIOR: Record<TaskClass, Record<ModelKey, number>> = {
  plan: { opus: 0.90, fable: 0.95, sonnet: 0.72, haiku: 0.40, gpt: 0.78 },
  critical_adr: { opus: 0.92, fable: 0.97, sonnet: 0.70, haiku: 0.35, gpt: 0.78 },
  implement: { opus: 0.88, fable: 0.92, sonnet: 0.80, haiku: 0.55, gpt: 0.78 },
  debug: { opus: 0.90, fable: 0.93, sonnet: 0.84, haiku: 0.50, gpt: 0.80 },
  review: { opus: 0.90, fable: 0.93, sonnet: 0.78, haiku: 0.50, gpt: 0.80 },
  mechanical: { opus: 0.80, fable: 0.80, sonnet: 0.75, haiku: 0.70, gpt: 0.72 },
  summary: { opus: 0.88, fable: 0.88, sonnet: 0.85, haiku: 0.83, gpt: 0.82 },
};
/** How much price matters per kind of work (1 = full weight). Plans and critical decisions are worth paying for. */
export const PRICE_WEIGHT: Record<TaskClass, number> = { plan: 0.25, critical_adr: 0.15, review: 0.25, implement: 0.5, debug: 0.5, mechanical: 0.5, summary: 0.5 };
/** The table's effort per class. Implementation is Sonnet at high: the user's working principle. */
export const EFFORT: Record<TaskClass, EffortLevel> = { plan: 'high', critical_adr: 'max', implement: 'high', debug: 'high', review: 'medium', mechanical: 'low', summary: 'low' };
/**
 * Author's beliefs, NOT measurements: quality change of an effort relative to `medium`, per class (additive). Research basis: high->xhigh adds ~1-4 points
 * at 2-4x cost, and in a coding sample low/high/xhigh solved 17/18/16 of 25. So for code `xhigh` is no better than `high`; only plans, debugging and review gain a little.
 * Real runs per pair replace these (see rank).
 */
export const PRIOR_EFFORT: Record<TaskClass, Partial<Record<EffortLevel, number>>> = {
  plan: { low: -0.08, high: 0.04, xhigh: 0.05, max: 0.05 },
  critical_adr: { low: -0.1, high: 0.04, xhigh: 0.06, max: 0.07 },
  implement: { low: -0.04, high: 0.04, xhigh: 0.04, max: 0.03 },
  debug: { low: -0.08, high: 0.05, xhigh: 0.06, max: 0.06 },
  review: { low: -0.08, high: 0.02, xhigh: 0.025, max: 0.025 },
  mechanical: { low: 0, high: 0, xhigh: 0, max: 0 },     // easy work: more thinking buys nothing (arXiv 2608.01347), so price decides and low wins
  summary: { low: 0, high: 0, xhigh: 0, max: 0 },
};
/** Output tokens an effort burns relative to medium (thinking is billed as output). Used until >= 3 runs at that effort are measured. */
export const EFFORT_PRICE_MULT: Record<EffortLevel, number> = { low: 0.6, medium: 1, high: 1.6, xhigh: 2.6, max: 3.5 };
/** Efforts each model is offered at. GPT/Codex and Haiku stop at high. */
const LEVELS: Record<ModelKey, readonly EffortLevel[]> = { opus: EFFORT_LEVELS, sonnet: EFFORT_LEVELS, fable: EFFORT_LEVELS, haiku: ['low', 'medium', 'high'], gpt: ['low', 'medium', 'high'] };
/** Guard rail: a class whose effort is not negotiable. Hard-to-reverse decisions always get the highest effort (a model without it gets its own top level). */
const EFFORT_FLOOR: Partial<Record<TaskClass, EffortLevel>> = { critical_adr: 'max' };
const levelsFor = (k: ModelKey, cls: TaskClass): readonly EffortLevel[] => {
  const all = LEVELS[k], floor = EFFORT_FLOOR[cls];
  if (!floor) return all;
  const up = all.filter((l) => EFFORT_LEVELS.indexOf(l) >= EFFORT_LEVELS.indexOf(floor));
  return up.length ? up : [all[all.length - 1] as EffortLevel];
};
const PRIOR_STRENGTH = 5;
const MIN_RUNS = 3;
const DIVERSITY_BONUS = 0.08;       // a reviewer from the other vendor catches what the author's own family misses
const SCARCITY_PENALTY = 0.06;      // quality-equivalent cost of draining an agent whose limit is nearly spent

/**
 * Price tier 0..1 for a typical task (mostly cached reads, some output) at an effort. Output tokens come from the measured profile of that agent and effort
 * when it has >= MIN_RUNS runs, else from the default scaled by the prior multiplier. GPT has no verified price: assumed equal to Sonnet and flagged.
 */
export function priceTier(k: ModelKey, effort: EffortLevel = 'medium', profile?: Profile): { tier: number; known: boolean; measured: boolean } {
  const measured = !!profile && profile.source === 'history' && profile.n >= MIN_RUNS;
  const out = measured ? (profile as Profile).p50.out : DEFAULT_PROFILE.p50.out * EFFORT_PRICE_MULT[effort];
  const usd = (m: string): number => costUsd(m, { ...DEFAULT_PROFILE.p50, out }) ?? 0;
  const ref = costUsd(MODEL_ID.fable, DEFAULT_PROFILE.p50) ?? 1;
  return { tier: usd(k === 'gpt' ? MODEL_ID.sonnet : MODEL_ID[k]) / ref, known: k !== 'gpt', measured };
}

/** One (model, effort) pair. `family` is the model, `key` the pair. `priceMeasured`: the price uses this effort's measured output tokens, not the prior multiplier. */
export interface Option { key: `${ModelKey}:${EffortLevel}`; family: ModelKey; agent: AgentId; model: string; effort: EffortLevel; quality: number; prior: number; runs: number; measured: boolean; price: number; priceKnown: boolean; priceMeasured: boolean; bonus: number; scarcity: number; distance: number }
export interface RankIn {
  cls: TaskClass; stats?: ModelStats; effortProfiles?: Record<string, Profile>; priceWeight?: number; codexModel?: string; implementedBy?: AgentId;
  allowed?: (k: ModelKey) => boolean; scarce?: Partial<Record<AgentId, boolean>>;
}

/** All allowed (model, effort) pairs, best (closest to the ideal) first. Ties keep Claude first. `stats` keys: `cls|model` (all efforts) and `cls|model|effort`; `effortProfiles` keys: `agent:effort`. */
export function rank(i: RankIn): Option[] {
  const out: Option[] = [];
  const lam = PRICE_WEIGHT[i.cls] * (i.priceWeight ?? 1);
  for (const key of ['sonnet', 'opus', 'haiku', 'fable', 'gpt'] as ModelKey[]) {
    if (i.allowed && !i.allowed(key)) continue;
    const agent = agentOf(key);
    const enough = (s: Stat | undefined): Stat | undefined => (s && s.n >= MIN_RUNS ? s : undefined);   // one or two runs are anecdotes, not data
    const st = enough(i.stats?.[`${i.cls}|${key}`]);
    const prior = PRIOR[i.cls][key];
    for (const effort of levelsFor(key, i.cls)) {
      const delta = PRIOR_EFFORT[i.cls][effort] ?? 0, pair = enough(i.stats?.[`${i.cls}|${key}|${effort}`]);
      const n = pair?.n ?? st?.n ?? 0;
      // this pair's own runs replace its prior; otherwise the model's runs (any effort) move the model and the effort delta rides on top
      const base = pair ? (PRIOR_STRENGTH * (prior + delta) + pair.score) / (PRIOR_STRENGTH + pair.n) : (PRIOR_STRENGTH * prior + (st?.score ?? 0)) / (PRIOR_STRENGTH + n) + delta;
      const bonus = i.cls === 'review' && i.implementedBy && i.implementedBy !== agent ? DIVERSITY_BONUS : 0;
      const scarcity = i.scarce?.[agent] ? SCARCITY_PENALTY : 0;
      const quality = Math.max(0, Math.min(1, base + bonus - scarcity));
      const p = priceTier(key, effort, i.effortProfiles?.[`${agent}:${effort}`]);
      const distance = Math.hypot(1 - quality, lam * p.tier);
      out.push({ key: `${key}:${effort}`, family: key, agent, model: key === 'gpt' ? i.codexModel ?? 'gpt-6.1-sol' : MODEL_ID[key], effort, quality: Math.round(quality * 1000) / 1000, prior, runs: n, measured: n >= MIN_RUNS, price: Math.round(p.tier * 1000) / 1000, priceKnown: p.known, priceMeasured: p.measured, bonus, scarcity, distance: Math.round(distance * 10000) / 10000 });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}
