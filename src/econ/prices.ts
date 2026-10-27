import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_HOME } from '../core/registry.ts';

/**
 * The price table: DATA (registry/prices.json) plus the user's own overrides (<hub home>/prices.json), never numbers buried in code.
 * A model with no row has no price (unknown, never 0). Loading never throws: a missing, oversized or malformed file is an empty set and bad rows are
 * dropped one by one, so a broken override leaves the bundled prices in force. Rows live in a Map: no prototype tricks from a hand-edited file.
 */
export interface Price { input: number; cacheRead: number; output: number }
/** One price band; `promptTokensUpTo` (inclusive) closes a band, the last band has none. */
export interface Tier extends Price { promptTokensUpTo?: number }
export interface PriceEntry { id: string; label?: string; tiers: Tier[]; source: string; date: string; dateKind?: 'checked' | 'recorded' | 'user'; url?: string }
export interface PriceTable { models: Map<string, PriceEntry>; overridden: Set<string>; rejected: number }

export const DEFAULT_PRICES_PATH = fileURLToPath(new URL('../../registry/prices.json', import.meta.url));
const MAX_BYTES = 64 * 1024, MAX_ROWS = 200, MAX_PER_MTOK = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const money = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_PER_MTOK;
const text = (x: unknown, max: number): string | undefined => (typeof x === 'string' && x.trim().length > 0 && x.length <= max ? x.trim() : undefined);
const badId = (id: string): boolean => !ID.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype';

function parseTiers(raw: unknown): Tier[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null;
  const out: Tier[] = []; let last = 0;
  for (const [i, t] of raw.entries()) {
    if (!isObj(t) || !money(t['input']) || !money(t['cacheRead']) || !money(t['output'])) return null;
    const up = t['promptTokensUpTo'];
    if (i < raw.length - 1) { if (typeof up !== 'number' || !Number.isInteger(up) || up <= last) return null; last = up; out.push({ promptTokensUpTo: up, input: t['input'], cacheRead: t['cacheRead'], output: t['output'] }); }
    else out.push({ input: t['input'], cacheRead: t['cacheRead'], output: t['output'] });   // the last band is open-ended
  }
  return out;
}

/** Validate an already-parsed file. Never throws. `fallback`: for a hand-edited override a row may omit its source and date. */
export function parsePrices(raw: unknown, fallback?: { source: string; date: string }): { models: Map<string, PriceEntry>; rejected: number } {
  const models = new Map<string, PriceEntry>(); let rejected = 0;
  const rows = isObj(raw) && isObj(raw['models']) ? Object.entries(raw['models']).slice(0, MAX_ROWS) : [];
  for (const [id, r] of rows) {
    const tiers = isObj(r) ? parseTiers(r['tiers']) : null;
    if (badId(id) || !isObj(r) || !tiers) { rejected++; continue; }
    const date = typeof r['date'] === 'string' && ISO.test(r['date']) ? r['date'] : fallback?.date, source = text(r['source'], 400) ?? fallback?.source;
    if (!source || !date) { rejected++; continue; }
    const url = typeof r['url'] === 'string' && /^https?:\/\/\S{1,300}$/.test(r['url']) ? r['url'] : undefined, label = text(r['label'], 80);
    models.set(id, { id, ...(label ? { label } : {}), tiers, source, date, ...(r['dateKind'] === 'checked' || r['dateKind'] === 'recorded' || r['dateKind'] === 'user' ? { dateKind: r['dateKind'] } : {}), ...(url ? { url } : {}) });
  }
  return { models, rejected };
}

function readFile(path: string, user = false): { models: Map<string, PriceEntry>; rejected: number } {
  try {
    const st = statSync(path);
    if (st.size > MAX_BYTES) return { models: new Map(), rejected: 0 };
    return parsePrices(JSON.parse(readFileSync(path, 'utf8')), user ? { source: 'вписано вами', date: st.mtime.toISOString().slice(0, 10) } : undefined);
  } catch { return { models: new Map(), rejected: 0 }; }
}

/** Bundled prices, with each row of `<home>/prices.json` replacing the bundled row of the same model. */
export function loadPriceTable(home: string = HUB_HOME, bundled: string = DEFAULT_PRICES_PATH): PriceTable {
  const base = readFile(bundled), over = readFile(join(home, 'prices.json'), true);
  const models = new Map(base.models), overridden = new Set<string>();
  for (const [id, e] of over.models) { const label = e.label ?? base.models.get(id)?.label; models.set(id, { ...e, ...(label ? { label } : {}) }); overridden.add(id); }
  return { models, overridden, rejected: base.rejected + over.rejected };
}

/** Newest `checked` date among the BUNDLED rows (the user's own overrides do not count as a check of anything). */
export const bundledCheckedAt = (bundled: string = DEFAULT_PRICES_PATH): string => [...readFile(bundled).models.values()].filter((e) => e.dateKind === 'checked').map((e) => e.date).sort().pop() ?? 'unknown';

let current: PriceTable | undefined;
/** The table in force (loaded on first use). */
export const priceTable = (): PriceTable => (current ??= loadPriceTable());
/** Read the files again, optionally from another hub home (tests; after the user edits a price). */
export const reloadPrices = (home: string = HUB_HOME): PriceTable => (current = loadPriceTable(home));

/** Writes (`price`) or removes (`null`) the user's override of one model in `<home>/prices.json`, then reloads. Throws on a bad name or number. */
export function saveOverride(home: string, id: string, price: Price | null): PriceTable {
  if (badId(id)) throw new Error('bad model name');
  if (price && !(money(price.input) && money(price.cacheRead) && money(price.output))) throw new Error('prices must be numbers from 0 to 10000 per 1M tokens');
  const path = join(home, 'prices.json');
  let existing: Record<string, unknown> = {};
  try { if (statSync(path).size <= MAX_BYTES) { const j = JSON.parse(readFileSync(path, 'utf8')) as unknown; if (isObj(j) && isObj(j['models'])) existing = j['models']; } } catch { /* a new file */ }
  const models: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) if (k !== id && !badId(k)) models[k] = v;
  if (price) models[id] = { tiers: [{ input: price.input, cacheRead: price.cacheRead, output: price.output }], source: 'вписано вами', date: new Date().toISOString().slice(0, 10), dateKind: 'user' };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ version: 1, models }, null, 2) + '\n'); renameSync(tmp, path);
  return reloadPrices(home);
}

/** The band that applies to a prompt of this size. */
export function tierFor(e: PriceEntry, promptTokens: number): Price {
  return (e.tiers.find((t) => t.promptTokensUpTo == null || promptTokens <= t.promptTokensUpTo) ?? e.tiers[e.tiers.length - 1]) as Price;
}
