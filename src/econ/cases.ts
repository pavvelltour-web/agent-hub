import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_HOME } from '../core/registry.ts';
import type { Db } from '../history/store.ts';
import { canonicalModel, costUsd } from './econ.ts';

/**
 * Anonymous "cases": what kind of task ran, on which model, what it cost and whether it worked.
 * NEVER included: prompts, answers, code, file names, folder paths, project names, branch names, error text, exact times.
 * Numbers are rounded into coarse buckets so a single run cannot be recognised by its exact token count.
 * Nothing leaves the computer: this module only builds a file the user can read and send themselves.
 */
export const CASE_VERSION = 1;
export const NEVER_INCLUDED = ['тексты запросов и ответов', 'код и имена файлов', 'пути к папкам', 'названия проектов и веток', 'тексты ошибок', 'точное время (только неделя)', 'пароли и ключи'];

export interface Case {
  v: number; task: string; projectType: string; agent: string; model: string; effort: string;
  outcome: string; rating: number | null;
  tokens: { newIn: number; cachedIn: number; out: number }; costUsd: number | null; minutes: number;
  handedOff: boolean; resumed: boolean; estimateHit: boolean | null; week: string;
}

/** ~1.8× steps (4 per decade): 12,345 → 10,000; 64,000 → 56,000. */
export const bucket = (n: number | null | undefined): number => { if (!n || n <= 0) return 0; const e = Math.floor(Math.log10(n) * 4) / 4; return Math.round(10 ** e); };
const isoWeek = (iso: string): string => { const d = new Date(iso); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`; };

export function buildCases(db: Db): Case[] {
  const rows = db.prepare("SELECT agent, model, effort, cls, outcome, rating, project_type AS pt, tokens_in AS tin, tokens_cached AS tc, tokens_out AS tout, started_at AS s, ended_at AS e, handoff_of AS ho, resume_of AS ro, est_json AS est FROM run WHERE outcome IN ('done','review','failed','limit','stopped') ORDER BY started_at").all() as unknown as { agent: string; model: string | null; effort: string | null; cls: string | null; outcome: string; rating: number | null; pt: string | null; tin: number | null; tc: number | null; tout: number | null; s: string; e: string | null; ho: string | null; ro: string | null; est: string | null }[];
  return rows.map((r) => {
    const cached = r.tc ?? 0, newIn = Math.max(0, (r.tin ?? 0) - cached), out = r.tout ?? 0;
    const model = canonicalModel(r.model) ?? r.model ?? 'unknown';
    let hit: boolean | null = null;
    if (r.est) { try { const t = (JSON.parse(r.est) as { tokens?: { low: { uncachedIn: number; cachedIn: number; out: number }; high: { uncachedIn: number; cachedIn: number; out: number } } }).tokens; if (t) { const w = (x: { uncachedIn: number; cachedIn: number; out: number }): number => x.uncachedIn + 0.1 * x.cachedIn + 5 * x.out; const a = newIn + 0.1 * cached + 5 * out; hit = a >= w(t.low) && a <= w(t.high); } } catch { hit = null; } }
    const usd = costUsd(model, { uncachedIn: newIn, cachedIn: cached, out });
    return { v: CASE_VERSION, task: r.cls ?? 'unclassified', projectType: r.pt ?? 'unknown', agent: r.agent, model, effort: r.effort ?? '-', outcome: r.outcome, rating: r.rating,
      tokens: { newIn: bucket(newIn), cachedIn: bucket(cached), out: bucket(out) }, costUsd: usd == null ? null : Math.round(usd * 100) / 100,
      minutes: r.e ? Math.max(1, Math.round((Date.parse(r.e) - Date.parse(r.s)) / 60000)) : 0, handedOff: !!r.ho, resumed: !!r.ro, estimateHit: hit, week: isoWeek(r.s) };
  });
}

/** Random id of this installation, only used to group one person's cases when they choose to send them. Delete the file to get a new one. */
export function installId(home = HUB_HOME): string {
  const p = join(home, 'install-id');
  try { return readFileSync(p, 'utf8').trim(); } catch { /* first time */ }
  const id = randomUUID(); mkdirSync(home, { recursive: true }); writeFileSync(p, id + '\n'); return id;
}

export function bundle(cases: Case[], home = HUB_HOME): { version: number; generatedAt: string; installId: string; count: number; neverIncluded: string[]; cases: Case[] } {
  return { version: CASE_VERSION, generatedAt: new Date().toISOString().slice(0, 10), installId: installId(home), count: cases.length, neverIncluded: NEVER_INCLUDED, cases };
}

/** Writes the file the user can inspect and send. Refuses without consent. Returns the path. */
export function exportCases(db: Db, consent: boolean, home = HUB_HOME): { path: string; count: number } {
  if (!consent) throw new Error('consent required: turn on "help improve forecasts" first');
  const b = bundle(buildCases(db), home);
  const dir = join(home, 'exports'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `cases-${b.generatedAt.replace(/-/g, '')}.json`);
  writeFileSync(path, JSON.stringify(b, null, 1));
  return { path, count: b.count };
}
export const lastExport = (home = HUB_HOME): string | null => { const d = join(home, 'exports'); try { return existsSync(d) ? d : null; } catch { return null; } };
