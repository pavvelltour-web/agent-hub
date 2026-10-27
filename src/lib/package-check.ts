/**
 * What the npm package may and must contain (checked by `scripts/security.mjs` against `npm pack --dry-run --json`; nothing is published).
 * Pure functions so the patterns are unit-tested name by name.
 */

/**
 * Private or generated: credentials and keys, hub state (handoff cards, audit, security reports), graph output, review caches, local databases,
 * logs, and test files of any script flavour. A name matches as a whole path segment (or as the file extension), not as a substring.
 */
const PRIVATE = /(^|\/)(\.env[^/]*|auth\.json[^/]*|\.credentials[^/]*|credentials\.json|\.npmrc|id_[rd]sa[^/]*|secrets|\.sandbox-secrets|refs-private|captures|\.hub|graphify-out|handoffs?|cache|\.cache|node_modules)(\/|$)|\.(sqlite|sqlite-wal|sqlite-shm|db|log|pem|key|pfx|p12|jks)$|\.(test|spec)\.[cm]?[jt]s$/;

/** Dev-only files that sit under shipped folders and must not ship: test fixtures and the source of the install-script checker. */
const NOT_SHIPPED = /^(src\/adapters\/fixtures\/|src\/history\/fixtures\/|src\/cli\/readonly-check\.ps1\.txt$)/;

/**
 * What a fresh install needs. `templates/<type>/.gitignore` ships as `gitignore` on purpose: npm drops a file named .gitignore from a package.
 * `src/lib/package-check.ts` and the prompts are read at run time (the security script imports the first; the review gate reads the second).
 */
const NEED = ['rules/base.md', 'modes/chat.json', 'modes/review.json', 'templates/web-saas/hub.json', 'templates/web-saas/gitignore', 'registry/starter.json', 'registry/entries/catalog.json', 'bin/hub.js', 'scripts/install.ps1', 'src/cli/main.ts', 'src/lib/package-check.ts', 'src/review/prompts/hunt.md', 'package.json', 'README.md'];
const NEED_DIRS = ['rules/', 'modes/', 'templates/', 'registry/'];

export interface PackageVerdict { priv: string[]; shipped: string[]; missing: string[] }

/** `list`: the paths `npm pack` would ship (forward slashes). */
export function checkPackageList(list: string[]): PackageVerdict {
  return {
    priv: list.filter((p) => PRIVATE.test(p)),
    shipped: list.filter((p) => NOT_SHIPPED.test(p)),
    missing: [...NEED.filter((p) => !list.includes(p)), ...NEED_DIRS.filter((d) => !list.some((p) => p.startsWith(d)))],
  };
}

/** True when `text` names this user's profile folder (`C:\Users\<name>\`, either slash, any case): a path of the machine that built the package. */
export function localUserPathIn(text: string, user: string): boolean {
  if (!user) return false;
  const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${esc}[\\\\/]`, 'i').test(text);
}
