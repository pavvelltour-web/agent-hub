import type { RegistryEntry } from './types.ts';

export interface Candidate { entry: RegistryEntry; score: number; reasons: string[] }

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-zа-я0-9]{4,}/g) ?? []);
const TYPE_RU: Record<string, string> = { 'web-saas': 'веб-проектов', 'mobile-app': 'мобильных приложений', automation: 'автоматизаций и ботов', 'design-study': 'дизайн-исследований' };

/**
 * Rank library entries for a project. Proposes only: never installs. Score = match with the brief + fit for the project type
 * + popularity, minus token and risk cost. `keepAll` keeps zero/negative scores (used for outside catalogs, where an empty query means "popular").
 */
export function scout(lib: RegistryEntry[], opts: { brief: string; projectType: string; installed?: string[]; limit?: number; keepAll?: boolean }): Candidate[] {
  const bw = words(opts.brief);
  const have = new Set(opts.installed ?? []);
  const out: Candidate[] = [];
  for (const e of lib) {
    if (have.has(e.id)) continue;
    const reasons: string[] = [];
    let s = 0;
    const hits = [...words(`${e.title} ${e.description} ${e.tags.join(' ')}`)].filter((w) => bw.has(w));
    if (hits.length) { s += Math.min(hits.length, 4) * 2; reasons.push(`подходит к задаче: ${hits.slice(0, 3).join(', ')}`); }
    if (e.projectTypes.includes(opts.projectType)) { s += 3; reasons.push(`для ${TYPE_RU[opts.projectType] ?? 'таких проектов'}`); }
    if (e.license && e.license !== 'unknown') s += 1; else reasons.push('лицензия не указана');
    if (e.downloads) { s += Math.log10(1 + e.downloads) * 0.5; if (e.downloads >= 1000) reasons.push(`популярный: ${e.downloads.toLocaleString('ru-RU')} установок`); }
    s -= e.tokenCost / 400;
    if (e.risk.executesCode) { s -= 0.5; reasons.push('запускает программы'); }
    if (e.risk.network) { s -= 0.5; reasons.push('ходит в интернет'); }
    if (s > 0 || opts.keepAll) out.push({ entry: e, score: Math.round(s * 10) / 10, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 5);
}
