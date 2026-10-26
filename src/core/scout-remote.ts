import { spawnSync } from 'node:child_process';
import type { Kind, RegistryEntry } from './types.ts';

/** Remote catalogs for `hub scout`. They only PROPOSE: nothing is downloaded or installed, the install command is shown to the user. */
export type Fetcher = (url: string) => Promise<unknown>;
export type GhRunner = (args: string[]) => { ok: boolean; out: string };

const TYPE_KIND: Record<string, Kind> = { skills: 'skill', mcps: 'mcp', hooks: 'hook', agents: 'agent', commands: 'command', plugins: 'plugin' };
const risk = (k: Kind): RegistryEntry['risk'] => ({ executesCode: k !== 'skill' && k !== 'agent', network: k === 'mcp', writesOutside: k === 'hook' });

export const defaultFetcher: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['www.aitmpl.com', 'aitmpl.com'].includes(u.hostname)) throw new Error('host not allowed');
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' }, redirect: 'error' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > 20_000_000) throw new Error('catalog too large');
  return r.json();
};

interface AitmplItem { scan?: { severity?: string }; id?: string; type?: string; name?: string; category?: string; description?: string; license?: string | null; downloads?: number; install?: { command?: string }; keywords?: string[] }

/** aitmpl.com catalog (documented in https://aitmpl.com/llms.txt: /api/v1/catalog/{type}.json). Components keep their own licenses. */
export async function fetchAitmpl(type: 'skills' | 'mcps' | 'hooks' | 'agents' | 'commands' = 'skills', fetcher: Fetcher = defaultFetcher): Promise<RegistryEntry[]> {
  const j = (await fetcher(`https://www.aitmpl.com/api/v1/catalog/${type}.json`)) as { components?: AitmplItem[] };
  const kind = TYPE_KIND[type] ?? 'skill';
  return (j.components ?? []).filter((c) => c.id && c.name).slice(0, 3000).map((c) => ({
    id: `aitmpl/${c.id}`, kind, title: String(c.name), description: String(c.description ?? '').slice(0, 400),
    source: { type: 'aitmpl' as const, ref: String(c.id) }, ...(c.install?.command ? { installCommand: c.install.command } : {}),
    license: c.license ?? 'unknown', tags: [c.category ?? '', ...(c.keywords ?? []).slice(0, 4)].filter(Boolean),
    stages: [], projectTypes: ['*'], compat: { claude: 'native' as const, codex: kind === 'skill' ? 'native' as const : 'unknown' as const },
    tokenCost: Math.ceil(((c.name ?? '').length + (c.description ?? '').length) / 4), risk: risk(kind), sourceVerified: false, ...(c.downloads ? { downloads: c.downloads } : {}), ...(c.scan?.severity ? { scan: String(c.scan.severity).toUpperCase() } : {}),
  }));
}

const defaultGh: GhRunner = (args) => { const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true }); return { ok: r.status === 0, out: r.stdout ?? '' }; };

/** GitHub repositories matching a query (read-only `gh search repos`; needs `gh` to be logged in). */
export function searchGithub(query: string, gh: GhRunner = defaultGh, limit = 10): RegistryEntry[] {
  if (!/^[\w.:/+#][\w .:/+#-]{1,99}$/.test(query)) throw new Error('query: letters, digits and . : / + # - only');
  const r = gh(['search', 'repos', query, '--limit', String(limit), '--json', 'fullName,description,license,stargazersCount,updatedAt,url']);
  if (!r.ok) throw new Error('gh search failed (is `gh` installed and logged in? run: gh auth login)');
  const rows = JSON.parse(r.out) as { fullName: string; description?: string; license?: { key?: string } | null; stargazersCount?: number; updatedAt?: string; url: string }[];
  return rows.map((x) => ({
    id: `github/${x.fullName}`, kind: 'skill' as const, title: x.fullName, description: `${x.description ?? ''} (★ ${x.stargazersCount ?? 0}, updated ${String(x.updatedAt ?? '').slice(0, 10)})`.slice(0, 400),
    source: { type: 'github' as const, repo: x.fullName }, installCommand: `git clone ${x.url}`, license: x.license?.key ?? 'unknown', tags: ['github'],
    stages: [], projectTypes: ['*'], compat: { claude: 'unknown' as const, codex: 'unknown' as const }, tokenCost: 0, risk: { executesCode: true, network: false, writesOutside: false }, sourceVerified: false,
  }));
}
