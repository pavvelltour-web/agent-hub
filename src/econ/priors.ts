import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelKey, TaskClass } from './router.ts';

/**
 * Vendor-strength priors: sourced facts about which model is strong at what, kept as DATA (registry/model-priors.json), never as magic numbers in router logic.
 * They are priors, not measurements: the router blends them in until the user's own runs say otherwise.
 * The loader never throws: a missing, oversized or malformed file gives an empty set and bad rows are dropped one by one.
 */
export const TAGS = ['terminal', 'doc-qa', 'computer-use', 'long-prompt', 'routine-build'] as const;
export type PriorTag = (typeof TAGS)[number];

/** One sourced claim. `quality` is the published score (0..1), or null for a stated direction without a number. */
export interface Prior { model: ModelKey; cls: TaskClass; tags: string[]; quality: number | null; source: string; date: string; dateKind?: 'published' | 'recorded'; url?: string }
/** Above `aboveTokens` of input the model's price is multiplied (`null`: a surcharge exists, its size is not known). */
export interface Surcharge { model: ModelKey; aboveTokens: number; priceMultiplier: number | null; source: string; date: string; dateKind?: 'published' | 'recorded'; url?: string }
export interface PriorSet { priors: Prior[]; surcharges: Surcharge[]; rejected: number }

export const DEFAULT_PRIORS_PATH = fileURLToPath(new URL('../../registry/model-priors.json', import.meta.url));
const MAX_BYTES = 256 * 1024, MAX_ROWS = 500;
const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'gpt']);
const CLASSES = new Set(['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A tag with a score on several models compares them (weight x distance from their mean); otherwise the named model gets a small lean. Author's constants, not measurements. */
export const TAG_WEIGHT = 0.5;
export const TAG_LEAN = 0.03;
/** A GPT surcharge of unknown size sorts GPT behind every Claude option (distance units; GPT is still used when Claude is out of limit). */
export const UNSIZED_SURCHARGE_PENALTY = 1;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x: unknown): string | null => (typeof x === 'string' && x.trim().length > 3 && x.length <= 400 ? x.trim() : null);
const isoDate = (x: unknown): string | null => (typeof x === 'string' && ISO.test(x) && !Number.isNaN(Date.parse(x)) ? x : null);
const common = (r: Record<string, unknown>): { source: string; date: string; dateKind?: 'published' | 'recorded'; url?: string } | null => {
  const source = text(r['source']), date = isoDate(r['date']);
  if (!source || !date || !MODELS.has(r['model'] as string)) return null;
  const url = typeof r['url'] === 'string' && /^https?:\/\/\S{1,300}$/.test(r['url']) ? r['url'] : undefined;
  return { source, date, ...(r['dateKind'] === 'published' || r['dateKind'] === 'recorded' ? { dateKind: r['dateKind'] } : {}), ...(url ? { url } : {}) };
};

/** Validate an already-parsed file. Never throws. */
export function parsePriors(raw: unknown): PriorSet {
  const out: PriorSet = { priors: [], surcharges: [], rejected: 0 };
  if (!isObj(raw)) return out;
  const rows = (k: string): unknown[] => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).slice(0, MAX_ROWS) : []);
  for (const r of rows('priors')) {
    const c = isObj(r) ? common(r) : null, o = r as Record<string, unknown>;
    const tags = isObj(r) && Array.isArray(o['tags']) ? (o['tags'] as unknown[]) : [];
    const q = isObj(r) ? o['quality'] : undefined;
    if (!c || !CLASSES.has(o['cls'] as string) || !tags.length || !tags.every((t) => typeof t === 'string' && (TAGS as readonly string[]).includes(t)) || !(q === null || (typeof q === 'number' && Number.isFinite(q) && q >= 0 && q <= 1))) { out.rejected++; continue; }
    out.priors.push({ model: o['model'] as ModelKey, cls: o['cls'] as TaskClass, tags: tags as string[], quality: q as number | null, ...c });
  }
  for (const r of rows('surcharges')) {
    const c = isObj(r) ? common(r) : null, o = r as Record<string, unknown>;
    const at = isObj(r) ? o['aboveTokens'] : undefined, m = isObj(r) ? o['priceMultiplier'] : undefined;
    if (!c || typeof at !== 'number' || !Number.isInteger(at) || at <= 0 || !(m === null || (typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= 20))) { out.rejected++; continue; }
    out.surcharges.push({ model: o['model'] as ModelKey, aboveTokens: at, priceMultiplier: m as number | null, ...c });
  }
  return out;
}

/** Read and validate a priors file. A missing, oversized or unreadable file is an empty set (the router then runs on its built-in beliefs). */
export function loadPriors(path: string = DEFAULT_PRIORS_PATH): PriorSet {
  try {
    if (statSync(path).size > MAX_BYTES) return { priors: [], surcharges: [], rejected: 0 };
    return parsePriors(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return { priors: [], surcharges: [], rejected: 0 }; }
}
export const PRIORS: PriorSet = loadPriors();

/** Tags implied by the size of the expected prompt: `long-prompt` above the smallest surcharge threshold in the data. */
export function tagsFor(expectedInputTokens: number | undefined, set: PriorSet = PRIORS): PriorTag[] {
  const limit = Math.min(...set.surcharges.map((s) => s.aboveTokens));
  return expectedInputTokens != null && Number.isFinite(limit) && expectedInputTokens > limit ? ['long-prompt'] : [];
}

/** Where a number came from: what the UI shows next to a recommendation. */
export interface Basis { tag: string; model: ModelKey; quality: number | null; source: string; date: string; dateKind?: 'published' | 'recorded' | undefined; url?: string | undefined }
const basisOf = (tag: string, p: { model: ModelKey; source: string; date: string; dateKind?: 'published' | 'recorded' | undefined; url?: string | undefined }, quality: number | null): Basis => ({ tag, model: p.model, quality, source: p.source, date: p.date, dateKind: p.dateKind, url: p.url });

/** Quality change per model for a class and a set of task tags, with the rows behind it. `long-prompt` is a price matter (see surchargeFor), not a quality one. */
export function tagEffect(set: PriorSet, cls: TaskClass, tags: readonly string[]): Map<ModelKey, { delta: number; basis: Basis[] }> {
  const out = new Map<ModelKey, { delta: number; basis: Basis[] }>();
  const add = (m: ModelKey, delta: number, b: Basis): void => { const x = out.get(m) ?? { delta: 0, basis: [] }; x.delta += delta; x.basis.push(b); out.set(m, x); };
  for (const tag of new Set(tags)) {
    if (!(TAGS as readonly string[]).includes(tag) || tag === 'long-prompt') continue;
    const first = new Map<ModelKey, Prior>();
    for (const r of set.priors) if (r.cls === cls && r.tags.includes(tag) && !first.has(r.model)) first.set(r.model, r);
    const scored = [...first.values()].filter((r) => r.quality != null);
    const mean = scored.reduce((a, r) => a + (r.quality as number), 0) / (scored.length || 1);
    for (const r of first.values()) add(r.model, r.quality == null || scored.length < 2 ? TAG_LEAN : TAG_WEIGHT * ((r.quality as number) - mean), basisOf(tag, r, r.quality));
  }
  return out;
}

/** The surcharge that applies to this model for these tags, if any. */
export function surchargeFor(set: PriorSet, model: ModelKey, tags: readonly string[]): Surcharge | undefined {
  return tags.includes('long-prompt') ? set.surcharges.find((s) => s.model === model) : undefined;
}
