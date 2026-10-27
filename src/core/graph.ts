import { spawn, spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, parse, resolve } from 'node:path';
import { killTree } from '../adapters/process.ts';
import { redact } from '../lib/redact.ts';
import { git, minimalEnv } from '../run/git.ts';

/** How to start graphify: a program and the arguments before the sub-command (`python -P -m graphify` has two). */
export interface GraphTool { cmd: string; prefix: string[] }
export type GraphState = 'built' | 'stale' | 'missing';
export interface GraphLast { ok: boolean; at: string; ms: number; message: string }
export interface GraphStatus { state: GraphState; builtAt: string | null; staleFiles: number; example: string | null; running: boolean; last: GraphLast | null }

/** `.graphifyignore` the hub offers: what must not be read into a graph (secrets, dependencies, build output, the graph's own output). */
export const GRAPHIGNORE = [
  '# Files graphify must not read. One pattern per line: a name, dir/, *, **, a leading / anchors at the project root.',
  '.git/', '.hub/', 'node_modules/', 'graphify-out/', 'dist/', 'build/', 'coverage/', '.next/', '.venv/', '__pycache__/',
  '.env', '.env.*', 'secrets/', '.sandbox-secrets/', 'auth.json', '.credentials.json', '*.pem', '*.key',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.min.js', '',
].join('\n');

const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'graphify-out', '.hub']);
const MAX_FILES = 50_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// ---- finding graphify ---------------------------------------------------------------------------------------------------------------

const envPath = (env: NodeJS.ProcessEnv): string => Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
/** First absolute PATH folder holding the program. Relative entries (`.`) are skipped: a project must not be able to supply the tool. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of envPath(env).split(delimiter).filter(Boolean)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, process.platform === 'win32' ? `${name}.exe` : name);   // a .cmd shim cannot be started without a shell
    try { if (statSync(p).isFile()) { if (process.platform !== 'win32') accessSync(p, constants.X_OK); return p; } } catch { /* next */ }
  }
  return undefined;
}

/** Runs `<tool> --help` from a neutral folder with the allowlisted environment: a real graphify prints its usage and exits 0. */
function works(t: GraphTool, env: NodeJS.ProcessEnv): boolean {
  try { const r = spawnSync(t.cmd, [...t.prefix, '--help'], { cwd: tmpdir(), env: minimalEnv(env), encoding: 'utf8', timeout: 20_000, windowsHide: true }); return r.status === 0 && /graphify/i.test(r.stdout ?? ''); } catch { return false; }
}

let located: { key: string; tool: GraphTool | undefined } | undefined;
/**
 * graphify as a program on PATH, or as a Python module (`python -P -m graphify`: `-P` keeps the working folder off the import path, so a
 * `graphify.py` in a project cannot take its place). `HUB_GRAPHIFY=off` switches the graph features off. The answer is remembered per PATH.
 */
export function locateGraphify(env: NodeJS.ProcessEnv = process.env): GraphTool | undefined {
  if (Object.entries(env).some(([k, v]) => k.toUpperCase() === 'HUB_GRAPHIFY' && v === 'off')) return undefined;
  const key = envPath(env);
  if (located?.key === key) return located.tool;
  let tool: GraphTool | undefined;
  const exe = onPath('graphify', env);
  if (exe && works({ cmd: exe, prefix: [] }, env)) tool = { cmd: exe, prefix: [] };
  else for (const py of ['python', 'python3']) {
    const p = onPath(py, env);
    if (p && works({ cmd: p, prefix: ['-P', '-m', 'graphify'] }, env)) { tool = { cmd: p, prefix: ['-P', '-m', 'graphify'] }; break; }
  }
  located = { key, tool };
  return tool;
}

// ---- status -------------------------------------------------------------------------------------------------------------------------

/** A small gitignore subset: a name or path, `dir/`, `*`, `**`, `?`, a leading `/` anchors at the root; `#` comments; no `!` negation. */
function ignoreMatcher(root: string): (rel: string) => boolean {
  let text = '';
  try { text = readFileSync(join(root, '.graphifyignore'), 'utf8'); } catch { /* none */ }
  const rxs = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((l) => {
    const anchored = l.startsWith('/') || l.replace(/\/$/, '').includes('/');
    const body = l.replace(/^\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
    return new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
  });
  return (rel) => rxs.some((r) => r.test(rel));
}

/** Files of the project that the graph should know about: git's list in a repository (honours .gitignore), else a bounded walk. */
function projectFiles(root: string): string[] {
  const g = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], minimalEnv());
  if (g.ok && g.out) return g.out.split('\0').filter(Boolean).slice(0, MAX_FILES).filter((f) => !ALWAYS_SKIP.has(f.split('/')[0]!));
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 14 || out.length >= MAX_FILES) return;
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink() || ALWAYS_SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r, depth + 1); else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '', 0);
  return out;
}

const jobs = new Map<string, { running: boolean; last: GraphLast | null }>();
const keyOf = (root: string): string => (process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));

/** built / stale / missing, by comparing the modification time of `graphify-out/graph.json` with the project's files. A deleted file is not noticed. */
export function graphStatus(root: string): GraphStatus {
  const job = jobs.get(keyOf(root));
  const base = { running: job?.running ?? false, last: job?.last ?? null };
  const gp = join(root, 'graphify-out', 'graph.json');
  let built: number;
  try { const s = statSync(gp); if (!s.isFile()) throw new Error('not a file'); built = s.mtimeMs; } catch { return { state: 'missing', builtAt: null, staleFiles: 0, example: null, ...base }; }
  const ignored = ignoreMatcher(root);
  let n = 0, newest = 0, example: string | null = null;
  for (const rel of projectFiles(root)) {
    if (ignored(rel)) continue;
    let m: number; try { const s = lstatSync(join(root, rel)); if (!s.isFile()) continue; m = s.mtimeMs; } catch { continue; }
    if (m > built) { n++; if (m > newest) { newest = m; example = rel; } }
  }
  return { state: n ? 'stale' : 'built', builtAt: new Date(built).toISOString(), staleFiles: n, example, ...base };
}

// ---- update -------------------------------------------------------------------------------------------------------------------------

const lastLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

/**
 * Run `graphify update <root>` in the background (re-reads the code files; needs no model and no network). One run per project at a time.
 * The tool gets: an argument array, an empty throw-away working folder under the hub home (it writes only `<root>/graphify-out`), the
 * allowlisted environment (no API keys, no hub tokens) and a timeout after which its process tree is killed. The result goes to
 * `<root>/.hub/audit.jsonl` (the Journal). `done` always resolves (a refused start resolves to a failed result and changes nothing).
 */
export function updateGraph(root: string, o: { tool: GraphTool; home: string; timeoutMs?: number }): { started: boolean; reason?: string; done: Promise<GraphLast> } {
  const refused = (reason: string): { started: false; reason: string; done: Promise<GraphLast> } => ({ started: false, reason, done: Promise.resolve({ ok: false, at: new Date().toISOString(), ms: 0, message: reason }) });
  if (!isAbsolute(root) || parse(root).root === root || !existsSync(root) || !statSync(root).isDirectory()) return refused('not a project folder');
  const key = keyOf(root);
  if (jobs.get(key)?.running) return refused('already running');
  const job = { running: true, last: jobs.get(key)?.last ?? null };
  jobs.set(key, job);
  const t0 = Date.now();
  const tmpRoot = join(o.home, 'tmp'); mkdirSync(tmpRoot, { recursive: true });
  const cwd = mkdtempSync(join(tmpRoot, 'graph-'));
  const done = new Promise<GraphLast>((resolveDone) => {
    let buf = '', settled = false, timedOut = false, timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean, message: string): void => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      const last: GraphLast = { ok, at: new Date().toISOString(), ms: Date.now() - t0, message: redact(message).slice(0, 300) };
      job.running = false; job.last = last;
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      try { mkdirSync(join(root, '.hub'), { recursive: true }); appendFileSync(join(root, '.hub', 'audit.jsonl'), JSON.stringify({ ts: last.at, action: 'graph-update', ok, ms: last.ms, note: last.message.slice(0, 160) }) + '\n'); } catch { /* the Journal just shows less */ }
      resolveDone(last);
    };
    let child;
    try { child = spawn(o.tool.cmd, [...o.tool.prefix, 'update', root], { cwd, env: minimalEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { finish(false, `could not start graphify: ${(e as Error).message}`); return; }
    timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const take = (d: Buffer): void => { buf = (buf + d.toString('utf8')).slice(-8000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', (e) => finish(false, `could not start graphify: ${e.message}`));
    child.on('close', (code) => {
      if (timedOut) finish(false, `timed out after ${Math.round((o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s and was stopped`);
      else if (code === 0) finish(true, lastLine(buf.split(/\r?\n/).filter((l) => /updated|rebuilt|nodes/i.test(l)).join('\n')) || 'graph updated');
      else finish(false, lastLine(buf) || `graphify exited with code ${code}`);
    });
  });
  return { started: true, done };
}
