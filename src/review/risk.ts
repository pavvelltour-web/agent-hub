export type RiskTier = 'low' | 'medium' | 'high';

const MAX_PATH = 1024;
const MAX_GLOB = 200;
const MAX_WHY_PATHS = 3;

/** Forward slashes, no `./` prefix, no doubled slashes. Case is kept; callers lowercase for matching. */
const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '');

const IMAGE = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|avif)$/;
const isDoc = (p: string): boolean => /\.mdx?$/.test(p) || p.startsWith('docs/') || IMAGE.test(p);

/** Paths that are always high, docs or not: pipeline files, agent rules, dependency manifests and lockfiles. */
const ALWAYS_HIGH: [RegExp, string][] = [
  [/^\.github\/(?:workflows|actions)\/|^\.circleci\/|(?:^|\/)(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile|\.travis\.yml)$/, 'CI / pipeline file'],
  [/(?:^|\/)(?:agents|claude)\.md$|(?:^|\/)rules\/|^\.(?:claude|codex)\/|(?:^|\/)\.cursorrules$|^\.cursor\/rules\/|^hub\.json$/, 'agent rules or configuration'],
  [/(?:^|\/)(?:package\.json|cargo\.toml|pyproject\.toml|go\.mod|requirements[^/]*\.txt)$/, 'dependency manifest'],
  [/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock|go\.sum|gemfile\.lock|composer\.lock|pipfile\.lock)$/, 'lockfile'],
  [/^\.husky\/|(?:^|\/)\.git\/hooks\//, 'git hook'],
];

const word = (alts: string): RegExp => new RegExp(`(?:^|[/._-])(?:${alts})(?:[/._-]|$)`);
/** Sensitive by name, code only (a document about billing is not a billing change). Lookalikes such as `keyboard` or `tokens.css` do not match: whole words only. */
const SENSITIVE: [RegExp, string][] = [
  [word('auth|oauth|authn|authz|login|logout|signin|signup|sso|passwords?|passwd|credentials?|secrets?|apikeys?|keys?|keychain|jwt'), 'authentication, keys or secrets'],
  [word('payments?|billing|checkout|stripe|paypal|invoices?|subscriptions?'), 'payments or billing'],
  [word('delete|deletion|destroy|purge|wipe'), 'deletion'],
  [/(?:^|[/._-])(?:install|installers?|uninstall)(?:[/._-]|$)|\.(?:msi|pkg|dmg|exe|deb|rpm)$/, 'installer'],
  [word('hooks?'), 'hooks'],
  [word('migrations?'), 'migration'],
];

/** Tiny glob: `*` inside a segment, `**` across segments, `?` one char, trailing `/` = the directory, no `/` = any depth. Case-insensitive. Unusable globs give null. */
function globToRegExp(glob: unknown): RegExp | null {
  if (typeof glob !== 'string') return null;
  let g = slash(glob.trim()).toLowerCase();
  if (!g || g.length > MAX_GLOB || g.includes('\0')) return null;
  if (g.endsWith('/')) g += '**';
  g = g.replace(/(?:\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**');
  if ((g.match(/\*\*/g) ?? []).length > 3) return null;
  let re = g.includes('/') ? '' : '(?:[^/]+/)*';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`); } catch { return null; }
}

export function globMatch(glob: string, path: string): boolean {
  const re = globToRegExp(glob);
  return re !== null && re.test(slash(String(path)).toLowerCase());
}

const outside = (p: string): boolean => p.length > MAX_PATH || p.includes('\0') || /^[a-z]:/i.test(p) || p.startsWith('/') || p.split('/').includes('..');

/**
 * Risk tier of a change from its paths alone. High: CI/pipeline files, agent rules (`AGENTS.md`, `CLAUDE.md`, `rules/**`), dependency manifests and
 * lockfiles, auth/keys/payments/billing/deletion/installer/hook/migration code, owner-listed `humanPaths`, and any path that is absolute, contains
 * `..`, NUL or is oversized. Low only when every path is docs/copy/images and none is high. Everything else is medium.
 */
export function riskTier(changedPaths: string[], o: { humanPaths: string[] }): { tier: RiskTier; why: string[] } {
  const owner = (Array.isArray(o?.humanPaths) ? o.humanPaths : []).map(globToRegExp).filter((r): r is RegExp => r !== null);
  const reasons = new Map<string, string[]>();
  const add = (why: string, p: string): void => { const l = reasons.get(why) ?? []; l.push(p.slice(0, 120)); reasons.set(why, l); };
  const paths = (Array.isArray(changedPaths) ? changedPaths : []).map((p) => String(p));
  let high = false, allDocs = paths.length > 0;
  for (const raw of paths) {
    const shown = slash(raw);
    if (outside(shown)) { add('path outside the project or malformed', shown); high = true; allDocs = false; continue; }
    const p = shown.toLowerCase();
    if (owner.some((r) => r.test(p))) { add('owner-listed path (humanPaths)', shown); high = true; allDocs = false; continue; }
    const always = ALWAYS_HIGH.find(([re]) => re.test(p));
    if (always) { add(always[1], shown); high = true; allDocs = false; continue; }
    if (isDoc(p)) continue;
    allDocs = false;
    const hit = SENSITIVE.find(([re]) => re.test(p));
    if (hit) { add(hit[1], shown); high = true; }
  }
  const why = [...reasons].map(([r, ps]) => `${r}: ${ps.slice(0, MAX_WHY_PATHS).join(', ')}${ps.length > MAX_WHY_PATHS ? ` (+${ps.length - MAX_WHY_PATHS} more)` : ''}`);
  if (high) return { tier: 'high', why };
  if (!paths.length) return { tier: 'low', why: ['no changed paths'] };
  return allDocs ? { tier: 'low', why: ['only docs, copy or images changed'] } : { tier: 'medium', why: ['source changes with no high-risk path'] };
}
