import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HubConfig } from '../core/types.ts';
import { isSecretPath, safeJoin } from '../lib/paths.ts';
import { redact } from '../lib/redact.ts';
import { unifiedLines } from './triage.ts';
import type { RawFinding } from './types.ts';

export interface CheckResult { name: string; ok: boolean; tail: string }
export interface CheckOpts { timeoutMs?: number }
type RunOne = (cwd: string, argv: string[], timeoutMs: number) => Promise<CheckResult>;

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

/** `node` is this node; on Windows `npm`/`npx` are .cmd shims that cannot be spawned without a shell, so run their JS entry with this node. */
function resolveCommand(cmd: string, args: string[]): [string, string[]] {
  if (cmd === 'node') return [process.execPath, args];
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${cmd}-cli.js`);
    if (existsSync(cli)) return [process.execPath, [cli, ...args]];
  }
  return [cmd, args];
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** One check: argv list, no shell, output tail redacted. Never rejects. */
export function runCheck(cwd: string, argv: string[], timeoutMs = TIMEOUT_MS): Promise<CheckResult> {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || !argv[0]) {
    return Promise.resolve(fail('invalid check', 'a check must be a non-empty list of strings (program and arguments)'));
  }
  const name = redact(argv.join(' ')).slice(0, 160);
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (r: CheckResult): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const env = { ...process.env }; delete env['NODE_TEST_CONTEXT'];
    const [file, args] = resolveCommand(argv[0]!, argv.slice(1));
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) { return resolve(fail(name, `could not start: ${(e as Error).message}`)); }
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ name, ok: false, tail: `${tailOf(buf)}\n[timed out after ${Math.round(timeoutMs / 1000)}s and killed]`.trim() });
    }, timeoutMs);
    const take = (c: string): void => { buf = (buf + c).slice(-KEEP_CHARS); };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.on('error', (e) => finish(fail(name, `could not start: ${e.message}`)));
    child.on('close', (code, signal) => finish({ name, ok: code === 0, tail: code === 0 ? tailOf(buf) : `${tailOf(buf)}\n[exit code ${code ?? signal}]`.trim() }));
  });
}

/** Runs every check in order (no short-circuit). Use `gateChecks` to decide whether the review may start. */
export async function runChecks(cwd: string, checks: string[][], o: CheckOpts = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const argv of checks) out.push(await runCheck(cwd, argv, o.timeoutMs));
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

/** A dependency the diff adds whose license is unknown or not on the small allow-list (read from `node_modules/<dep>/package.json`; not installed = unknown). */
export function dependencyFindings(diffText: string, cwd: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const d of addedDependencies(diffText)) {
    const lic = licenseOf(cwd, d.name);
    if (lic !== undefined && licenseAllowed(lic)) continue;
    const shown = printable(d.name);
    out.push({
      lens: 'security', category: 'risk', file: d.file, line: d.line, classOfBug: 'unvetted-dependency',
      title: lic === undefined ? `New dependency "${shown}" with unknown license` : `New dependency "${shown}" with license ${printable(lic)} (not allow-listed)`,
      evidence: `${d.file} adds "${shown}": "${printable(d.spec)}". License: ${lic === undefined ? 'unknown (package not installed, unreadable or no license field)' : printable(lic)}. Allow-list: ${[...LICENSES].join(', ')}. Vet the package and its license before accepting; this project avoids new dependencies.`,
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

/**
 * The gate before any AI review: secret scan of the diff, then each check in order. The first red result stops everything (`ok: false`);
 * the caller must not start hunters then. Added dependencies are reported as an informational `new-dependency` result (their findings come from `dependencyFindings`).
 */
export async function gateChecks(cwd: string, checks: string[][], o: { diffText?: string; timeoutMs?: number; run?: RunOne } = {}): Promise<{ ok: boolean; results: CheckResult[] }> {
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
    const r = await run(cwd, argv, o.timeoutMs ?? TIMEOUT_MS);
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
