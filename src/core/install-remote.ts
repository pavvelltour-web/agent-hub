import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSafeName } from '../lib/paths.ts';
import { change, effective } from './plan.ts';
import { HUB_HOME, library } from './registry.ts';
import type { McpSpec, Plan, RegistryEntry } from './types.ts';

/**
 * Put a catalog component into the hub LIBRARY (~/.agent-hub), not into any agent's global folder.
 * A skill there costs no tokens anywhere until a project links it. The user sees the full text and the catalog's own
 * security scan first, nothing runs, and the apply step only accepts what was previewed (digest).
 */
const REPO = 'davila7/claude-code-templates';
export const MAX_FILE = 200_000, MAX_TOTAL = 1_000_000, MAX_FILES = 40;
/** `signal` is an outer deadline (for example the time budget of one skill); it is combined with the 20 s per-request timeout. */
export type TextFetcher = (url: string, maxChars?: number, signal?: AbortSignal) => Promise<string>;

const ALLOWED = (u: URL): boolean => u.protocol === 'https:' && ((u.hostname === 'www.aitmpl.com' || u.hostname === 'aitmpl.com') || (u.hostname === 'raw.githubusercontent.com' && u.pathname.startsWith(`/${REPO}/`)));

/**
 * A text fetcher limited to the hosts `allowed` accepts: no redirects (a redirect to another host is an error), 20 s per request plus an optional outer deadline,
 * and a size cap enforced while the body streams: a body that never ends or lies about its length is cut off at the cap (4 bytes per character), never buffered.
 */
export const makeTextFetcher = (allowed: (u: URL) => boolean): TextFetcher => async (url, maxChars = MAX_FILE, signal) => {
  if (!allowed(new URL(url))) throw new Error('host not allowed');
  const r = await fetch(url, { signal: signal ? AbortSignal.any([AbortSignal.timeout(20_000), signal]) : AbortSignal.timeout(20_000), redirect: 'error' });
  if (!r.ok) { await r.body?.cancel().catch(() => undefined); throw new Error(`HTTP ${r.status} for ${url.split('/').slice(-2).join('/')}`); }
  if (Number(r.headers.get('content-length') ?? 0) > maxChars * 2) { await r.body?.cancel().catch(() => undefined); throw new Error('file too large'); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = r.body?.getReader();
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxChars * 4) { await reader.cancel().catch(() => undefined); throw new Error('file too large'); }
    chunks.push(value);
  }
  const t = new TextDecoder().decode(Buffer.concat(chunks));
  if (t.length > maxChars) throw new Error('file too large');
  return t;
};
export const defaultTextFetcher: TextFetcher = makeTextFetcher(ALLOWED);

interface RawItem { id: string; type: string; name: string; path: string; description?: string; license?: string | null; files?: string[] | null; urls?: { content?: string }; scan?: { severity?: string; score?: number; tool?: string } }
export interface Preview {
  id: string; kind: 'skill' | 'mcp'; name: string; description: string; license: string; scan: { severity: string; score: number | null; tool: string } | null;
  files: { path: string; size: number }[]; text: string; mcp?: McpSpec; runsCode: boolean; blocked?: string; digest: string;
  /** exact bytes to write: relative path → text (kept server-side, not sent to the panel in full except `text`) */
  payload: Record<string, string>;
}

const REL = /^[\w.-]+(\/[\w.-]+)*$/;
export const relOk = (p: string): boolean => REL.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '.git');

/** Catalog item → everything that would be written, without writing. Throws on malformed input; `blocked` marks a refusal with the reason. */
export async function previewComponent(id: string, fetchText: TextFetcher = defaultTextFetcher): Promise<Preview> {
  const m = /^aitmpl\/(skills|mcps)\/([\w.-]+\/[\w.-]+)$/.exec(id);
  if (!m) throw new Error('only aitmpl skills and mcps can be fetched');
  const type = m[1] as 'skills' | 'mcps';
  const cat = JSON.parse(await fetchText(`https://www.aitmpl.com/api/v1/catalog/${type}.json`, 20_000_000)) as { components?: RawItem[] };
  const it = (cat.components ?? []).find((c) => c.id === id.slice('aitmpl/'.length));
  if (!it) throw new Error('not in the catalog');
  const scan = it.scan?.severity ? { severity: String(it.scan.severity).toUpperCase(), score: typeof it.scan.score === 'number' ? it.scan.score : null, tool: String(it.scan.tool ?? 'scanner') } : null;
  const contentUrl = it.urls?.content;
  if (!contentUrl) throw new Error('catalog entry has no content link');
  const content = (JSON.parse(await fetchText(contentUrl)) as { content?: string }).content ?? '';
  if (!content) throw new Error('empty component');
  const base: Pick<Preview, 'id' | 'description' | 'license' | 'scan'> = { id, description: String(it.description ?? '').slice(0, 600), license: it.license ?? 'unknown', scan };
  const refuse = (p: Omit<Preview, 'digest' | 'blocked'>, why?: string): Preview => ({ ...p, ...(why ? { blocked: why } : {}), digest: createHash('sha256').update(JSON.stringify([p.id, p.payload])).digest('hex') });

  if (type === 'skills') {
    const fm = parseFrontmatter(content);
    const name = fm['name'] ?? it.name;
    const payload: Record<string, string> = { 'SKILL.md': content };
    const others = (it.files ?? []).filter((f) => f !== 'SKILL.md');
    let total = content.length, why: string | undefined;
    if (!isSafeName(name) || name !== it.name) why = 'skill name is unsafe or differs from the catalog name';
    else if (others.length + 1 > MAX_FILES) why = `too many files (${others.length + 1} > ${MAX_FILES})`;
    else if (scan && ['HIGH', 'CRITICAL'].includes(scan.severity)) why = `the catalog's own scan (${scan.tool}) rated it ${scan.severity}; read it on GitHub first`;
    for (const f of others) {
      if (why) break;
      if (!relOk(f)) { why = `unsafe file path in the catalog: ${f}`; break; }
      try { const t = await fetchText(`https://raw.githubusercontent.com/${REPO}/main/cli-tool/components/skills/${it.path}/${f}`); total += t.length; if (t.includes('\u0000') || total > MAX_TOTAL) why = `file ${f} is binary or the skill is too large`; else payload[f] = t; }
      catch (e) { why = `could not fetch ${f}: ${(e as Error).message}`; }
    }
    const runsCode = Object.keys(payload).some((f) => /\.(py|sh|js|mjs|ts|ps1|bat|cmd)$/i.test(f)) || /scripts\//.test(content);
    if (!why && library().some((e) => e.id === `skill/${name}` && e.source.type === 'local')) why = 'a skill with this name already exists in your library';
    return refuse({ ...base, kind: 'skill', name: String(name), files: Object.entries(payload).map(([path, t]) => ({ path, size: t.length })), text: content, runsCode, payload }, why);
  }

  let cfg: { mcpServers?: Record<string, { command?: string; args?: unknown[]; url?: string; env?: Record<string, string>; description?: string }> };
  try { cfg = JSON.parse(content); } catch { throw new Error('the MCP config is not valid JSON'); }
  const [name, srv] = Object.entries(cfg.mcpServers ?? {})[0] ?? [];
  if (!name || !srv) throw new Error('no server in the MCP config');
  const spec: McpSpec = { ...(srv.url ? { url: srv.url } : { command: String(srv.command ?? ''), args: (srv.args ?? []).map(String) }), ...(srv.env ? { env: Object.keys(srv.env) } : {}) };
  let why: string | undefined;
  if (!isSafeName(name)) why = 'server name is unsafe';
  else if (spec.url ? !/^https:\/\//.test(spec.url) : !spec.command) why = 'server has neither an https url nor a command';
  else if (library().some((e) => e.id === `mcp/${name}`)) why = 'an MCP with this name already exists in your library';
  return refuse({ ...base, kind: 'mcp', name, files: [], text: content, mcp: spec, runsCode: !spec.url, payload: { [`${name}.json`]: content } }, why);
}

const slug = (id: string): string => id.slice('aitmpl/'.length).replace(/\//g, '-');

/** Dry-run plan inside the hub home. Skills become folders in ~/.agent-hub/skills; an MCP becomes a library entry (env VALUES are never stored). */
export function planLibraryInstall(p: Preview): Plan {
  if (p.blocked) throw new Error(p.blocked);
  const changes = [];
  if (p.kind === 'skill') for (const [rel, text] of Object.entries(p.payload)) changes.push(change(join(HUB_HOME, 'skills', p.name, ...rel.split('/')), text, rel === 'SKILL.md' ? `library skill from ${p.id} (${p.license})` : undefined));
  else {
    const entry: RegistryEntry = { id: `mcp/${p.name}`, kind: 'mcp', title: p.name, description: p.description, source: { type: 'aitmpl', ref: p.id.slice('aitmpl/'.length) }, license: p.license, tags: ['aitmpl'], stages: [], projectTypes: ['*'],
      compat: { claude: 'native', codex: 'native' }, tokenCost: 0, risk: { executesCode: p.runsCode, network: true, writesOutside: false }, sourceVerified: false, ...(p.mcp ? { mcp: p.mcp } : {}) };
    changes.push(change(join(HUB_HOME, 'registry', `${slug(p.id)}.json`), JSON.stringify([entry], null, 2) + '\n', 'library MCP entry (no secrets stored)'));
  }
  return effective({ root: HUB_HOME, changes, notes: [
    ...(p.scan ? [`catalog scan: ${p.scan.tool} → ${p.scan.severity}${p.scan.score != null ? ` (score ${p.scan.score})` : ''}`] : ['no security scan result in the catalog for this item']),
    ...(p.runsCode ? ['contains scripts or starts a program: read them before linking it to a project'] : []),
    ...(p.mcp?.env?.length ? [`needs environment variables you set yourself: ${p.mcp.env.join(', ')}`] : []),
  ] });
}
