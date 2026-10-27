import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
export interface PriceEntry { id: string; label?: string; tiers: Tier[]; source: string; date: string; dateKind?: 'checked' | 'recorded' | 'user'; url?: string;
  /** Context window in tokens, when the row names one (the context gauge, ADR-024). Absent = unknown; the bundled table names none. */
  window?: number }
/** A row that was dropped, and why (shown to the user: the reason is plain Russian). */
export interface RejectedRow { id: string; reason: string }
export interface PriceTable { models: Map<string, PriceEntry>; overridden: Set<string>; rejected: number; rejectedRows: RejectedRow[]; /** Set when the override file exists but cannot be used as a whole (unreadable, too big, too many rows). */ overrideProblem?: string }

export const DEFAULT_PRICES_PATH = fileURLToPath(new URL('../../registry/prices.json', import.meta.url));
const MAX_BYTES = 64 * 1024, MAX_ROWS = 200, MAX_PER_MTOK = 10_000;
/** A window is a whole number of tokens between a thousand and a hundred million; anything else is ignored (the row keeps its price, the window stays unknown). */
const validWindow = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1000 && x <= 100_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A price is a positive number: a $0 row would make a model free to the router, and no model in the registry is free in any column (cache hits included). */
const money = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= MAX_PER_MTOK;
const text = (x: unknown, max: number): string | undefined => (typeof x === 'string' && x.trim().length > 0 && x.length <= max ? x.trim() : undefined);
const badId = (id: string): boolean => !ID.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype';

const BAD_PRICE = 'цена должна быть числом больше нуля и не больше 10000 за 1 млн токенов';
function parseTiers(raw: unknown): Tier[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return 'нет цен (нужен список из 1-4 ступеней)';
  const out: Tier[] = []; let last = 0;
  for (const [i, t] of raw.entries()) {
    if (!isObj(t) || !money(t['input']) || !money(t['cacheRead']) || !money(t['output'])) return BAD_PRICE;
    const up = t['promptTokensUpTo'];
    if (i < raw.length - 1) { if (typeof up !== 'number' || !Number.isInteger(up) || up <= last) return 'границы ступеней должны расти'; last = up; out.push({ promptTokensUpTo: up, input: t['input'], cacheRead: t['cacheRead'], output: t['output'] }); }
    else out.push({ input: t['input'], cacheRead: t['cacheRead'], output: t['output'] });   // the last band is open-ended
  }
  return out;
}

/** Validate an already-parsed file. Never throws. `fallback`: for a hand-edited override a row may omit its source and date. */
export function parsePrices(raw: unknown, fallback?: { source: string; date: string }): { models: Map<string, PriceEntry>; rejected: number; rejectedRows: RejectedRow[] } {
  const models = new Map<string, PriceEntry>(); const rejectedRows: RejectedRow[] = [];
  const rows = isObj(raw) && isObj(raw['models']) ? Object.entries(raw['models']).slice(0, MAX_ROWS) : [];
  for (const [id, r] of rows) {
    const tiers = isObj(r) ? parseTiers(r['tiers']) : 'строка не похожа на цену';
    if (badId(id) || !isObj(r) || typeof tiers === 'string') { rejectedRows.push({ id: id.slice(0, 64), reason: badId(id) ? 'недопустимое имя модели' : typeof tiers === 'string' ? tiers : 'строка не похожа на цену' }); continue; }
    const date = typeof r['date'] === 'string' && ISO.test(r['date']) ? r['date'] : fallback?.date, source = text(r['source'], 400) ?? fallback?.source;
    if (!source || !date) { rejectedRows.push({ id, reason: 'нет источника или даты' }); continue; }
    const url = typeof r['url'] === 'string' && /^https?:\/\/\S{1,300}$/.test(r['url']) ? r['url'] : undefined, label = text(r['label'], 80);
    models.set(id, { id, ...(label ? { label } : {}), ...(validWindow(r['window']) ? { window: r['window'] } : {}), tiers, source, date, ...(r['dateKind'] === 'checked' || r['dateKind'] === 'recorded' || r['dateKind'] === 'user' ? { dateKind: r['dateKind'] } : {}), ...(url ? { url } : {}) });
  }
  return { models, rejected: rejectedRows.length, rejectedRows };
}

/** What a price file says, or why it cannot be used as a whole (`problem`). A missing file is fine (`missing`); everything else unusable is a problem the user is told about. */
type Read = { models: Map<string, PriceEntry>; rejected: number; rejectedRows: RejectedRow[]; problem?: string; missing?: boolean };
const NONE = { models: new Map<string, PriceEntry>(), rejected: 0, rejectedRows: [] as RejectedRow[] };
function readFile(path: string, user = false): Read {
  let st;
  try { st = statSync(path); } catch { return { ...NONE, missing: true }; }
  try {
    if (st.size > MAX_BYTES) return { ...NONE, problem: `файл с ценами слишком большой (больше ${MAX_BYTES / 1024} КБ), его цены не используются` };
    const json = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (isObj(json) && isObj(json['models']) && Object.keys(json['models']).length > MAX_ROWS) return { ...NONE, problem: `в файле с ценами больше ${MAX_ROWS} строк, его цены не используются` };
    return parsePrices(json, user ? { source: 'вписано вами', date: st.mtime.toISOString().slice(0, 10) } : undefined);
  } catch { return { ...NONE, problem: 'файл с ценами не удалось прочитать как JSON, его цены не используются' }; }
}

/** Bundled prices, with each row of `<home>/prices.json` replacing the bundled row of the same model. */
export function loadPriceTable(home: string = HUB_HOME, bundled: string = DEFAULT_PRICES_PATH): PriceTable {
  const base = readFile(bundled), over = readFile(join(home, 'prices.json'), true);
  const models = new Map(base.models), overridden = new Set<string>();
  for (const [id, e] of over.models) { const label = e.label ?? base.models.get(id)?.label, window = e.window ?? base.models.get(id)?.window; models.set(id, { ...e, ...(label ? { label } : {}), ...(window ? { window } : {}) }); overridden.add(id); }
  return { models, overridden, rejected: base.rejected + over.rejected, rejectedRows: [...base.rejectedRows, ...over.rejectedRows], ...(over.problem ? { overrideProblem: over.problem } : {}) };
}

/** Newest `checked` date among the BUNDLED rows (the user's own overrides do not count as a check of anything). */
export const bundledCheckedAt = (bundled: string = DEFAULT_PRICES_PATH): string => [...readFile(bundled).models.values()].filter((e) => e.dateKind === 'checked').map((e) => e.date).sort().pop() ?? 'unknown';

let current: PriceTable | undefined, currentHome: string = HUB_HOME, sig = '', checkedAt = 0;
const signature = (home: string): string => { try { const st = statSync(join(home, 'prices.json')); return `${st.size}:${st.mtimeMs}`; } catch { return 'none'; } };
/** The table in force. The override file may be edited by hand or by another program, so its size and time are re-checked at most once a second. */
export function priceTable(): PriceTable {
  const now = Date.now();
  if (!current || now - checkedAt > 1000) { checkedAt = now; const g = signature(currentHome); if (!current || g !== sig) { sig = g; current = loadPriceTable(currentHome); } }
  return current;
}
/** Read the files again, optionally from another hub home (tests; after the user edits a price). */
export const reloadPrices = (home: string = HUB_HOME): PriceTable => { currentHome = home; sig = signature(home); checkedAt = Date.now(); return (current = loadPriceTable(home)); };

/** Writes (`price`) or removes (`null`) the user's override of one model in `<home>/prices.json`, then reloads. Throws, and leaves the file as it is, on a bad name or number and on a file it cannot read whole (a save must never replace rows it could not see). The read-modify-write is synchronous, so two saves in one process cannot interleave; the temp file name is unique so two processes do not share one. */
export function saveOverride(home: string, id: string, price: Price | null): PriceTable {
  if (badId(id)) throw new Error('bad model name');
  if (price && !(money(price.input) && money(price.cacheRead) && money(price.output))) throw new Error('prices must be numbers above 0 and up to 10000 per 1M tokens');
  const path = join(home, 'prices.json');
  const cur = readFile(path, true);
  if (cur.problem) throw new Error(cur.problem + '; исправьте или удалите файл ' + path);
  let existing: Record<string, unknown> = {};
  if (!cur.missing) { const j = JSON.parse(readFileSync(path, 'utf8')) as unknown; if (isObj(j) && isObj(j['models'])) existing = j['models']; }
  const models: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) if (k !== id && !badId(k)) models[k] = v;
  const keepWindow = isObj(existing[id]) && validWindow(existing[id]['window']) ? { window: existing[id]['window'] } : {};   // a window the user wrote survives a price change
  if (price) models[id] = { tiers: [{ input: price.input, cacheRead: price.cacheRead, output: price.output }], source: 'вписано вами', date: new Date().toISOString().slice(0, 10), dateKind: 'user', ...keepWindow };
  if (Object.keys(models).length > MAX_ROWS) throw new Error(`в файле с ценами не может быть больше ${MAX_ROWS} строк`);
  const body = JSON.stringify({ version: 1, models }, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`файл с ценами стал бы больше ${MAX_BYTES / 1024} КБ`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { writeFileSync(tmp, body); renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
  return reloadPrices(home);
}

/** The band that applies to a prompt of this size. */
export function tierFor(e: PriceEntry, promptTokens: number): Price {
  return (e.tiers.find((t) => t.promptTokensUpTo == null || promptTokens <= t.promptTokensUpTo) ?? e.tiers[e.tiers.length - 1]) as Price;
}
