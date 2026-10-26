import { costUsd, DEFAULT_PROFILE } from './econ.ts';
import type { AgentId } from '../core/types.ts';

/**
 * Picks the model that sits closest to the ideal "top quality at zero price".
 * Every option is a point (quality 0..1, price tier 0..1); distance to the ideal corner is the score. Lower is better.
 *   quality = (5 × prior + sum of observed scores) / (5 + runs)     prior = the author's guess until real runs replace it
 *   price   = cost of the model relative to the most expensive one, for a typical task mix (GPT price unknown → treated as Sonnet)
 * The price weight depends on the kind of work: for plans quality matters most, for rote work price does.
 */
export type TaskClass = 'plan' | 'critical_adr' | 'implement' | 'debug' | 'review' | 'mechanical' | 'summary';
export type ModelKey = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'gpt';
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
export const EFFORT: Record<TaskClass, string> = { plan: 'high', critical_adr: 'max', implement: 'medium', debug: 'high', review: 'medium', mechanical: 'low', summary: 'low' };
const PRIOR_STRENGTH = 5;
const MIN_RUNS = 3;
const DIVERSITY_BONUS = 0.08;       // a reviewer from the other vendor catches what the author's own family misses
const SCARCITY_PENALTY = 0.06;      // quality-equivalent cost of draining an agent whose limit is nearly spent

/** Price tier 0..1 for a typical task (mostly cached reads, some output). GPT has no verified price: assumed equal to Sonnet and flagged. */
export function priceTier(k: ModelKey): { tier: number; known: boolean } {
  const usd = (m: string): number => costUsd(m, DEFAULT_PROFILE.p50) ?? 0;
  const ref = usd(MODEL_ID.fable);
  return k === 'gpt' ? { tier: usd(MODEL_ID.sonnet) / ref, known: false } : { tier: usd(MODEL_ID[k]) / ref, known: true };
}

export interface Option { key: ModelKey; agent: AgentId; model: string; effort: string; quality: number; prior: number; runs: number; measured: boolean; price: number; priceKnown: boolean; bonus: number; scarcity: number; distance: number }
export interface RankIn {
  cls: TaskClass; stats?: ModelStats; priceWeight?: number; codexModel?: string; implementedBy?: AgentId;
  allowed?: (k: ModelKey) => boolean; scarce?: Partial<Record<AgentId, boolean>>;
}

/** All allowed options, best (closest to the ideal) first. Ties keep Claude first. */
export function rank(i: RankIn): Option[] {
  const out: Option[] = [];
  const lam = PRICE_WEIGHT[i.cls] * (i.priceWeight ?? 1);
  for (const key of ['sonnet', 'opus', 'haiku', 'fable', 'gpt'] as ModelKey[]) {
    if (i.allowed && !i.allowed(key)) continue;
    const agent = agentOf(key);
    const raw = i.stats?.[`${i.cls}|${key}`];
    const st = raw && raw.n >= MIN_RUNS ? raw : undefined;   // one or two runs are anecdotes, not data
    const prior = PRIOR[i.cls][key], n = st?.n ?? 0;
    const base = (PRIOR_STRENGTH * prior + (st?.score ?? 0)) / (PRIOR_STRENGTH + n);
    const bonus = i.cls === 'review' && i.implementedBy && i.implementedBy !== agent ? DIVERSITY_BONUS : 0;
    const scarcity = i.scarce?.[agent] ? SCARCITY_PENALTY : 0;
    const quality = Math.max(0, Math.min(1, base + bonus - scarcity));
    const p = priceTier(key);
    const distance = Math.hypot(1 - quality, lam * p.tier);
    out.push({ key, agent, model: key === 'gpt' ? i.codexModel ?? 'gpt-6.1-sol' : MODEL_ID[key], effort: EFFORT[i.cls], quality: Math.round(quality * 1000) / 1000, prior, runs: n, measured: n >= MIN_RUNS, price: Math.round(p.tier * 1000) / 1000, priceKnown: p.known, bonus, scarcity, distance: Math.round(distance * 10000) / 10000 });
  }
  return out.sort((a, b) => a.distance - b.distance);
}
