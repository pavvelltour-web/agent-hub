import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentId } from '../core/types.ts';
import type { Tokens } from '../econ/econ.ts';
import { agentOf, modelKey, type TaskClass } from '../econ/router.ts';
import { git } from '../run/git.ts';
import type { RunManager } from '../run/runner.ts';

export interface GoldenTask { id: string; cls: TaskClass; prompt: string; fixture: string; verify: string[] }
export interface Pick { agent: AgentId; model: string; effort: string }
export interface BenchRow { taskId: string; agent: string; model: string; effort: string; solved: boolean; tokens: Tokens; costUsd: number | null; limitPct: number | null; seconds: number }
export interface BenchOpts { tasks: GoldenTask[]; picks: Pick[]; runs: RunManager; repeat: number; runTimeoutMs?: number }

const CLASSES = new Set(['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary']);

/** `sonnet:high,gpt-6.1-sol:medium` → picks; the agent follows from the model name. Only plain tokens: these end up in argv. */
export function parsePicks(spec: string): Pick[] {
  return spec.split(',').map((p) => {
    const m = /^([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/.exec(p.trim());
    if (!m) throw new Error(`bad pick "${p}": expected model:effort, e.g. sonnet:high`);
    return { agent: agentOf(modelKey(m[1] as string)), model: m[1] as string, effort: m[2] as string };
  });
}

/** Reads `tasks.json`; a task's `fixture` is a folder name under `fixtures/` and comes back as an absolute path. */
export function loadTasks(dir: string): GoldenTask[] {
  const raw = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as { tasks?: Partial<GoldenTask>[] };
  return (raw.tasks ?? []).map((t) => {
    if (!t.id || !t.prompt || !t.fixture || !t.cls || !CLASSES.has(t.cls) || !Array.isArray(t.verify) || !t.verify.length) throw new Error(`golden task is malformed: ${t.id ?? '?'}`);
    const fixture = resolve(dir, 'fixtures', t.fixture);
    if (!fixture.startsWith(resolve(dir, 'fixtures')) || !existsSync(fixture)) throw new Error(`golden task ${t.id}: fixture not found`);
    return { id: t.id, cls: t.cls, prompt: t.prompt, fixture, verify: t.verify };
  });
}

/** The fixture is a plain file tree: copy it into a fresh git repo so every attempt starts from the same state. */
function freshRepo(fixture: string): string {
  const d = mkdtempSync(join(tmpdir(), 'hub-bench-'));
  cpSync(fixture, d, { recursive: true });
  git(d, ['init', '-q', '-b', 'main']); git(d, ['add', '-A']);
  git(d, ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'fixture']);
  return d;
}

/** Runs a verify argv in `cwd`. Outside env: NODE_TEST_CONTEXT is dropped, or a nested `node --test` inside a test runner exits 0 without running anything. */
export function runVerify(argv: string[], cwd: string): boolean {
  const [cmd, ...args] = argv;
  if (!cmd) return false;
  const env = { ...process.env }; delete env['NODE_TEST_CONTEXT'];
  return spawnSync(cmd === 'node' ? process.execPath : cmd, args, { cwd, env, stdio: 'ignore', timeout: 120_000 }).status === 0;
}

function finished(runs: RunManager, id: string, timeoutMs: number): Promise<void> {
  return new Promise((done) => {
    const un = runs.subscribe(id, (e) => { if (e.kind === 'end') { clearTimeout(t); un(); done(); } });
    const t = setTimeout(() => { runs.stop(id); un(); done(); }, timeoutMs);
    if (runs.get(id)?.outcome != null) { clearTimeout(t); un(); done(); }
  });
}

export async function runBench(o: BenchOpts): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const task of o.tasks) for (const pick of o.picks) for (let i = 0; i < o.repeat; i++) {
    const t0 = Date.now();
    const row: BenchRow = { taskId: task.id, agent: pick.agent, model: pick.model, effort: pick.effort, solved: false, tokens: { uncachedIn: 0, cachedIn: 0, out: 0 }, costUsd: null, limitPct: null, seconds: 0 };
    try {
      const repo = freshRepo(task.fixture);
      const run = o.runs.start({ agent: pick.agent, prompt: task.prompt, projectRoot: repo, model: pick.model, effort: pick.effort, cls: task.cls });
      await finished(o.runs, run.id, o.runTimeoutMs ?? 15 * 60_000);
      const r = o.runs.get(run.id);
      if (r) {
        row.tokens = { uncachedIn: (r.tokensIn ?? 0) - (r.tokensCached ?? 0), cachedIn: r.tokensCached ?? 0, out: r.tokensOut ?? 0 };
        row.costUsd = r.costUsd;
      }
      if (r?.outcome === 'done') {
        row.solved = runVerify(task.verify, repo);
      }
    } catch { /* a run that could not start is an unsolved attempt, not a crashed bench */ }
    row.seconds = Math.round((Date.now() - t0) / 100) / 10;
    rows.push(row);
  }
  return rows;
}

export function summarize(rows: BenchRow[]): { pick: string; solved: number; costPerSolved: number | null; pctPerSolved: number | null }[] {
  const by = new Map<string, BenchRow[]>();
  for (const r of rows) { const k = `${r.agent}:${r.model}:${r.effort}`; by.set(k, [...(by.get(k) ?? []), r]); }
  const per = (total: number, n: number): number | null => (n > 0 ? Math.round((total / n) * 1e6) / 1e6 : null);
  return [...by].map(([pick, rs]) => {
    const solved = rs.filter((r) => r.solved).length;
    const pcts = rs.filter((r) => r.limitPct != null);
    return { pick, solved, costPerSolved: per(rs.reduce((s, r) => s + (r.costUsd ?? 0), 0), solved), pctPerSolved: pcts.length ? per(pcts.reduce((s, r) => s + (r.limitPct as number), 0), solved) : null };
  });
}
