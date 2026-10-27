import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { HubConfig } from '../core/types.ts';
import { isSecretPath, safeJoin } from '../lib/paths.ts';
import { redact } from '../lib/redact.ts';
import { unifiedLines } from './triage.ts';
import type { RawFinding } from './types.ts';

export interface CheckResult { name: string; ok: boolean; tail: string }
export interface CheckOpts { timeoutMs?: number; env?: NodeJS.ProcessEnv }
type RunOne = (cwd: string, argv: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<CheckResult>;

const TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 40;
const KEEP_CHARS = 200_000;
const MAX_JSON = 1_000_000;

const fail = (name: string, tail: string): CheckResult => ({ name, ok: false, tail: redact(tail) });
const tailOf = (text: string): string => redact(text.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).slice(-TAIL_LINES).join('\n'));

function readJson(path: string): unknown {
  try {
    if (statSync(path).size > MAX_JSON) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return undefined; }
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
const pathOf = (env: NodeJS.ProcessEnv): string => Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
const notFound = (cmd: string): string => `не найден запускатель ${printable(cmd)}; укажите полный путь в hub.json review.checks`;
const shimRefused = (cmd: string, shim: string): string =>
  `не найден запускатель ${printable(cmd)}: есть только ${printable(shim)}, а файл .cmd/.bat без оболочки не запускается (через cmd.exe аргументы нельзя передать безопасно). Укажите в hub.json review.checks полный путь к .exe или ["node", "<путь к .js>"]`;

/**
 * `node` is this node. On Windows `npm`/`npx` run their JS entry next to this node (they are .cmd shims); any other bare name is looked up on
 * PATH as .exe/.com. A .cmd/.bat (pnpm, yarn, tsc, nvm/volta shims) is refused with a hint: it needs cmd.exe, and its argument quoting is not safe.
 */
function resolveCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[] } | { error: string } {
  if (cmd === 'node') return { file: process.execPath, args };
  if (process.platform !== 'win32') return { file: cmd, args };
  if (cmd === 'npm' || cmd === 'npx') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${cmd}-cli.js`);
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] };
  }
  if (/\.(?:cmd|bat)$/i.test(cmd)) return { error: shimRefused(cmd, cmd) };
  if (/[\\/]/.test(cmd) || isAbsolute(cmd)) return { file: cmd, args };
  let shim: string | undefined;
  for (const d of pathOf(env).split(';').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const ext of /\.(?:exe|com)$/i.test(cmd) ? [''] : ['.exe', '.com']) { const p = join(d, cmd + ext); if (isFile(p)) return { file: p, args }; }
    for (const ext of ['.cmd', '.bat']) { const p = join(d, cmd + ext); if (!shim && isFile(p)) shim = p; }
  }
  return { error: shim ? shimRefused(cmd, shim) : notFound(cmd) };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * One check: argv list, no shell, output tail redacted. Never rejects. `env` is what the check sees (the gate passes a minimal env without hub
 * secrets and with the push guard); the default is this process's env.
 */
export function runCheck(cwd: string, argv: string[], timeoutMs = TIMEOUT_MS, env0: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || !argv[0]) {
    return Promise.resolve(fail('invalid check', 'a check must be a non-empty list of strings (program and arguments)'));
  }
  const name = redact(argv.join(' ')).slice(0, 160);
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (r: CheckResult): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const env = { ...env0 }; delete env['NODE_TEST_CONTEXT'];
    const cmd = resolveCommand(argv[0]!, argv.slice(1), env);
    if ('error' in cmd) return resolve(fail(name, `could not start: ${cmd.error}`));
    let child;
    try {
      child = spawn(cmd.file, cmd.args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) { return resolve(fail(name, `could not start: ${notFound(argv[0]!)} (${(e as Error).message})`)); }
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ name, ok: false, tail: `${tailOf(buf)}\n[timed out after ${Math.round(timeoutMs / 1000)}s and killed]`.trim() });
    }, timeoutMs);
    const take = (c: string): void => { buf = (buf + c).slice(-KEEP_CHARS); };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.on('error', (e) => finish(fail(name, `could not start: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? `${notFound(argv[0]!)} (${e.message})` : e.message}`)));
    child.on('close', (code, signal) => finish({ name, ok: code === 0, tail: code === 0 ? tailOf(buf) : `${tailOf(buf)}\n[exit code ${code ?? signal}]`.trim() }));
  });
}

/** Runs every check in order (no short-circuit). Use `gateChecks` to decide whether the review may start. */
export async function runChecks(cwd: string, checks: string[][], o: CheckOpts = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const argv of checks) out.push(await runCheck(cwd, argv, o.timeoutMs, o.env));
  return out;
}

// ---------- in-process pseudo-checks on the diff text ----------

const HEADER = /^(?:diff --git |--- |\+\+\+ |rename (?:from|to) |copy (?:from|to) )/;
const EXAMPLE = /\.(?:example|sample|template)$/i;

/**
 * Red when the diff adds a secret-looking value (any `+` line, headers included, so nothing hides behind a malformed hunk) or touches a secret path
 * (`.env`, `auth.json`, keys...; `.env.example` is fine). The tail names kinds and files, never the value.
 */
export function scanDiffForSecrets(diffText: string): CheckResult {
  const kinds = new Set<string>(), files = new Set<string>(), paths = new Set<string>();
  let hits = 0, file = '(unknown file)';
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith('+++ ')) file = /^\+\+\+ (?:"?b\/)?([^\t"]*)/.exec(line)?.[1] || file;
    if (HEADER.test(line)) {
      for (const tok of line.replace(/["\t]/g, ' ').split(' ')) {
        const p = tok.replace(/^[ab]\//, '');
        if (p && isSecretPath(p) && !EXAMPLE.test(p)) paths.add(p);
      }
    }
    if (line[0] !== '+') continue;
    const body = line.slice(1, 100_001);
    const red = redact(body);
    if (red === body) continue;
    hits++; files.add(file);
    for (const m of red.matchAll(/\[REDACTED:([a-z-]+)\]/g)) kinds.add(m[1]!);
  }
  const parts: string[] = [];
  if (hits) parts.push(`${hits} added line(s) look like secrets (${[...kinds].join(', ') || 'unknown kind'}) in ${[...files].slice(0, 5).join(', ')}`);
  if (paths.size) parts.push(`touches secret path(s): ${[...paths].slice(0, 5).join(', ')}`);
  return parts.length ? fail('secret-scan', parts.join('; ')) : { name: 'secret-scan', ok: true, tail: 'no secret-looking additions' };
}

const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SECTION = /"(dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:\s*\{/;
const OBJECT_OPEN = /"[^"]+"\s*:\s*\{/;
const PAIR = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;
/** JSON-decode a quoted fragment (`left-pad` is `left-pad`); an undecodable one stays raw so it is still reported. */
const unescape = (raw: string): string => { try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; } };
const SPEC = /^(?:[\^~<>=*]|\d|latest$|next$|npm:|file:|git|https?:|github:|workspace:|link:)/;
const NOT_DEPS = new Set(['version', 'name', 'description', 'main', 'module', 'types', 'license', 'type', 'author', 'homepage', 'url', 'node', 'npm', 'pnpm', 'yarn', 'packagemanager']);
const LICENSES = new Set(['mit', 'isc', 'bsd-2-clause', 'bsd-3-clause', 'apache-2.0', '0bsd', 'unlicense', 'cc0-1.0', 'blueoak-1.0.0']);

interface AddedDep { file: string; line: number; name: string; spec: string }

/** Dependencies a diff of any `package.json` ADDS (a bump of an existing key is not new). */
function addedDependencies(diffText: string): AddedDep[] {
  const out: AddedDep[] = [];
  const removed = new Set<string>();
  const found: AddedDep[] = [];
  let state: 'deps' | 'other' | 'unknown' = 'unknown';
  let prev: { file: string | null; line: number } = { file: null, line: -1 };
  for (const l of unifiedLines(diffText)) {
    if (l.file === null || !/(?:^|\/)package\.json$/.test(l.file)) { prev = { file: null, line: -1 }; continue; }
    // a new hunk (line numbers jump) restarts the section guess
    if (l.op !== '-' && prev.file === l.file && prev.line >= 0 && l.line !== prev.line + 1) state = 'unknown';
    if (prev.file !== l.file) state = 'unknown';
    if (l.op !== '-') prev = { file: l.file, line: l.line };
    const m = PAIR.exec(l.text);
    if (l.op === '-') { if (m) removed.add(`${l.file}\0${unescape(m[1]!)}`); continue; }
    if (SECTION.test(l.text)) { state = 'deps'; continue; }
    if (OBJECT_OPEN.test(l.text)) { state = 'other'; continue; }
    if (/^\s*\}/.test(l.text)) { state = 'other'; continue; }
    if (l.op !== '+' || !m) continue;
    const name = unescape(m[1]!), spec = unescape(m[2]!);
    if (state === 'deps' || (state === 'unknown' && SPEC.test(spec) && !NOT_DEPS.has(name.toLowerCase()))) found.push({ file: l.file, line: l.line, name, spec });
  }
  for (const d of found) if (!removed.has(`${d.file}\0${d.name}`)) out.push(d);
  return out;
}

function licenseOf(cwd: string, name: string): string | undefined {
  if (!NAME.test(name) || name.length > 214) return undefined;
  let p: string;
  try { p = safeJoin(cwd, 'node_modules', name, 'package.json'); } catch { return undefined; }
  const pkg = readJson(p);
  if (!isObj(pkg)) return undefined;
  const lic = pkg['license'];
  if (typeof lic === 'string') return lic;
  if (isObj(lic) && typeof lic['type'] === 'string') return lic['type'];
  const many = pkg['licenses'];
  if (Array.isArray(many)) return many.map((x) => (isObj(x) ? String(x['type']) : String(x))).join(' OR ');
  return undefined;
}

const licenseAllowed = (expr: string): boolean =>
  expr.replace(/[()]/g, ' ').split(/\s+or\s+/i).some((alt) => alt.split(/\s+and\s+/i).every((t) => LICENSES.has(t.trim().toLowerCase())));

const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

/** Well-known permissive packages accepted without a license lookup. Keep tiny: everything else is vetted by a human. */
const KNOWN_PERMISSIVE = new Set(['typescript', '@types/node']);
/** A plain registry version range. `file:`, `git…`, `npm:` aliases, URLs and workspace links install something else than the name says. */
const REGISTRY_SPEC = /^\s*(?:[\^~]|[<>]=?|=)?\s*v?\d+(?:\.[\dx*]+){0,2}(?:-[\w.]+)?\s*$|^\s*(?:\*|latest)\s*$/i;

/**
 * A dependency the diff adds is a `security` finding unless it is on the tiny built-in list or the PROJECT ROOT's installed copy
 * (`<root>/node_modules/<dep>/package.json`, never the task folder's: the agent can write that one) has an allow-listed license, and the spec is a
 * plain registry range. Not installed in the root = unknown.
 */
export function dependencyFindings(diffText: string, root: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const d of addedDependencies(diffText)) {
    const registry = REGISTRY_SPEC.test(d.spec);
    if (registry && KNOWN_PERMISSIVE.has(d.name)) continue;
    const lic = licenseOf(root, d.name);
    if (registry && lic !== undefined && licenseAllowed(lic)) continue;
    const shown = printable(d.name);
    out.push({
      lens: 'security', category: 'risk', file: d.file, line: d.line, classOfBug: 'unvetted-dependency',
      title: !registry ? `New dependency "${shown}" from a non-registry source` : lic === undefined ? `New dependency "${shown}" with unknown license` : `New dependency "${shown}" with license ${printable(lic)} (not allow-listed)`,
      evidence: `${d.file} adds "${shown}": "${printable(d.spec)}". License: ${lic === undefined ? 'unknown (not installed in the project root, unreadable or no license field)' : printable(lic)}. The license is read only from the project root's installed copy; the task folder's node_modules is never trusted (the agent can write it). Allow-list: ${[...LICENSES].join(', ')}. Vet the package and its license before accepting; this project avoids new dependencies.`,
    });
  }
  return out;
}

// ---------- configuration and defaults ----------

/** `review` from the project's hub.json. Unknown keys are ignored, malformed values dropped; never throws. Note: hub.json can come from a cloned repository. */
export function readReviewConfig(cwd: string): NonNullable<HubConfig['review']> {
  const cfg = readJson(join(cwd, 'hub.json'));
  const r = isObj(cfg) ? cfg['review'] : undefined;
  if (!isObj(r)) return {};
  const out: NonNullable<HubConfig['review']> = {};
  if (typeof r['effort'] === 'string') out.effort = r['effort'];
  if (Array.isArray(r['checks'])) {
    const ok = r['checks'].filter((c): c is string[] => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string'));
    if (ok.length) out.checks = ok;
  }
  if (Array.isArray(r['humanPaths'])) {
    const ok = r['humanPaths'].filter((g): g is string => typeof g === 'string');
    if (ok.length) out.humanPaths = ok;
  }
  return out;
}

/** hub.json `review.checks`, else the `test` and `typecheck` scripts of package.json; plus `node scripts/security.mjs` when it exists. */
export function defaultChecks(cwd: string): string[][] {
  const configured = readReviewConfig(cwd).checks;
  const checks: string[][] = configured ? configured.map((c) => [...c]) : [];
  if (!configured) {
    const pkg = readJson(join(cwd, 'package.json'));
    const scripts = isObj(pkg) && isObj(pkg['scripts']) ? pkg['scripts'] : {};
    if (typeof scripts['test'] === 'string') checks.push(['npm', 'test']);
    if (typeof scripts['typecheck'] === 'string') checks.push(['npm', 'run', 'typecheck']);
  }
  const sec = ['node', 'scripts/security.mjs'];
  if (existsSync(join(cwd, 'scripts', 'security.mjs')) && !checks.some((c) => c.join(' ') === sec.join(' '))) checks.push(sec);
  return checks;
}

// ---------- what the checks will run, and the user's approval of exactly that ----------

export const NO_CHECKS_WARNING = 'Нет проверок: тесты/типизация не запускались';
export const BRANCH_CODE_NOTE = 'Проверки запускают код ветки (скрипты package.json, scripts/security.mjs, node_modules) с вашими правами, вне песочницы агента. Агент мог его изменить.';
const HEX40 = /^[0-9a-f]{40}$/;
const NPM_LIKE = /^(?:npm|npx|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/i;
const NODE_FILE = /\.(?:m?js|cjs|ts|mts|cts)$/i;
const SECURITY: string[] = ['node', 'scripts/security.mjs'];
const isSecurityCheck = (c: string[]): boolean => c.join(' ') === SECURITY.join(' ');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface CheckPlan {
  /** argv lists, in run order. */
  checks: string[][];
  /** Where the list came from: hub.json `review.checks`, else the package.json scripts, else only the security script. */
  source: 'hub.json' | 'package.json' | 'scripts/security.mjs' | 'none';
  /** The package.json scripts (with npm's pre/post) that the npm-like checks run, as the branch head has them. */
  scripts: Record<string, string>;
  /** sha256 of each file a `node <file>` check runs (and `.npmrc` for npm-like checks), from the branch head; null = not in the commit. */
  files: Record<string, string | null>;
  /** sha256 over checks + the whole `scripts` object + files: what the user approves. */
  digest: string;
  approved: boolean;
  /** No check besides the security script: tests and type check did not run. */
  noTests: boolean;
  note: string;
}

type Reader = (rel: string) => string | null;
/** Files as commit `sha` of `tree` has them (a blob only, no textconv); without a sha, from disk under `tree`. */
function treeReader(tree: string, sha: string): Reader {
  if (HEX40.test(sha)) {
    return (rel) => {
      if (!rel || rel.startsWith('-') || rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) return null;
      const r = spawnSync('git', ['--no-pager', 'cat-file', 'blob', `${sha}:${rel.replace(/\\/g, '/')}`], { cwd: tree, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * MAX_JSON, timeout: 30_000 });
      return r.status === 0 && typeof r.stdout === 'string' && r.stdout.length <= MAX_JSON ? r.stdout : null;
    };
  }
  return (rel) => { try { const p = safeJoin(tree, rel); return statSync(p).size > MAX_JSON ? null : readFileSync(p, 'utf8'); } catch { return null; } };
}

/** Script names an npm-like check runs (npm's own pre/post hooks are added by the caller). */
function scriptNames(argv: string[]): string[] {
  if (!NPM_LIKE.test(basename(argv[0] ?? ''))) return [];
  const words = argv.slice(1).filter((a) => !a.startsWith('-'));
  const sub = words[0] ?? '';
  if (['test', 't', 'tst'].includes(sub)) return ['test'];
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) return words[1] ? [words[1]] : [];
  if (['start', 'stop', 'restart'].includes(sub)) return [sub];
  if (['install', 'i', 'ci', 'add'].includes(sub)) return ['preinstall', 'install', 'postinstall', 'prepare'];
  return /^(?:pnpm|yarn|bun)/i.test(basename(argv[0] ?? '')) && sub ? [sub] : [];
}

const rootKey = (root: string): string => resolve(root).replace(/\\/g, '/').toLowerCase();
const approvalFile = (home: string): string => join(home, 'review-checks-approved.json');
function approvals(home: string): Record<string, string[]> {
  const j = readJson(approvalFile(home));
  return isObj(j) ? Object.fromEntries(Object.entries(j).filter((e): e is [string, string[]] => Array.isArray(e[1]))) : {};
}

/**
 * What the review's checks would run for commit `sha` of the task folder `tree`, and whether the user approved exactly that on this machine.
 * The list comes from the project root's hub.json (`review.checks`), else from the BRANCH HEAD package.json (`test`, `typecheck`), plus
 * `node scripts/security.mjs` when the branch head has it. The digest covers the argv lists, the whole branch `scripts` object when an npm-like
 * check runs (a changed `test` script needs a new approval), `.npmrc`, and the content of every `node <file>` the checks start.
 */
export function planChecks(root: string, tree: string, sha: string, home: string): CheckPlan {
  const read = treeReader(tree, sha);
  const configured = readReviewConfig(root).checks;
  const checks: string[][] = configured ? configured.map((c) => [...c]) : [];
  let pkg: unknown; try { const t = read('package.json'); pkg = t === null ? undefined : JSON.parse(t); } catch { pkg = undefined; }
  const all = isObj(pkg) && isObj(pkg['scripts']) ? Object.fromEntries(Object.entries(pkg['scripts']).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  if (!configured) {
    if (typeof all['test'] === 'string') checks.push(['npm', 'test']);
    if (typeof all['typecheck'] === 'string') checks.push(['npm', 'run', 'typecheck']);
  }
  if (read(SECURITY[1]!) !== null && !checks.some(isSecurityCheck)) checks.push([...SECURITY]);
  const npmLike = checks.some((c) => NPM_LIKE.test(basename(c[0] ?? '')));
  const scripts: Record<string, string> = {};
  for (const c of checks) for (const n of scriptNames(c)) for (const k of [`pre${n}`, n, `post${n}`]) if (typeof all[k] === 'string') scripts[k] = all[k];
  const files: Record<string, string | null> = {};
  for (const c of checks) {
    if (c[0] !== 'node') continue;
    const f = c.slice(1).find((a) => !a.startsWith('-'));
    if (c.slice(1).some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print') || !f || !NODE_FILE.test(f)) continue;
    const t = read(f); files[f.replace(/\\/g, '/')] = t === null ? null : sha256(t);
  }
  if (npmLike) { const t = read('.npmrc'); files['.npmrc'] = t === null ? null : sha256(t); }
  const digest = sha256(JSON.stringify({ v: 1, checks, scripts: npmLike ? all : {}, files }));
  const source = configured ? 'hub.json' : npmLike ? 'package.json' : checks.length ? 'scripts/security.mjs' : 'none';
  return { checks, source, scripts, files, digest, approved: !checks.length || (approvals(home)[rootKey(root)] ?? []).includes(digest), noTests: !checks.some((c) => !isSecurityCheck(c)), note: BRANCH_CODE_NOTE };
}

/** The reason a review stops when its checks are not approved. */
export const notApprovedReason = (p: Pick<CheckPlan, 'source'>): string => `Проверки из ${p.source === 'none' ? 'hub.json' : p.source} не одобрены`;

/**
 * Records the user's approval of the checks for commit `sha` of `tree`. `digest` must be the one the server computes now: a list that changed
 * since it was shown is refused. Keeps the last 20 approved digests per project (switching branches does not ask again for a known list).
 */
export function approveChecks(root: string, tree: string, sha: string, digest: string, home: string): CheckPlan {
  const plan = planChecks(root, tree, sha, home);
  if (typeof digest !== 'string' || digest !== plan.digest) throw new Error('the checks changed since they were shown: look at them again');
  const all = approvals(home); const key = rootKey(root);
  all[key] = [digest, ...(all[key] ?? []).filter((d) => d !== digest)].slice(0, 20);
  mkdirSync(dirname(approvalFile(home)), { recursive: true });
  writeFileSync(approvalFile(home), JSON.stringify(all, null, 1));
  return { ...plan, approved: true };
}

/**
 * The gate before any AI review: secret scan of the diff, then each check in order. The first red result stops everything (`ok: false`);
 * the caller must not start hunters then. Added dependencies are reported as an informational `new-dependency` result (their findings come from `dependencyFindings`).
 */
export async function gateChecks(cwd: string, checks: string[][], o: { diffText?: string; timeoutMs?: number; run?: RunOne; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; results: CheckResult[] }> {
  const run = o.run ?? runCheck;
  const results: CheckResult[] = [];
  if (o.diffText !== undefined) {
    const s = scanDiffForSecrets(o.diffText);
    results.push(s);
    if (!s.ok) return { ok: false, results };
    const added = addedDependencies(o.diffText);
    if (added.length) results.push({ name: 'new-dependency', ok: true, tail: redact(`${added.length} new dependenc${added.length === 1 ? 'y' : 'ies'}: ${added.slice(0, 10).map((d) => printable(d.name)).join(', ')}`) });
  }
  for (const argv of checks) {
    const r = await run(cwd, argv, o.timeoutMs ?? TIMEOUT_MS, o.env);
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
