import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Second review round, S2 and N4: only a runaway RUN is a failure; shared-limit stops are neutral; guard-stopped runs stay out of the token profiles and shared cases.
const base = mkdtempSync(join(tmpdir(), 'hub-brk2-'));
process.env['USERPROFILE'] = base; process.env['HOME'] = base; process.env['AGENT_HUB_HOME'] = join(base, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { evaluate, DEFAULT_CAPS, readFacts } = await import('./breaker.ts');
type Fact = import('./breaker.ts').Fact;
const { RunManager } = await import('./runner.ts');
const econ = await import('../econ/econ.ts');
const { buildCases } = await import('../econ/cases.ts');
const { openDb } = await import('../history/store.ts');
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });

const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const until = async (fn: () => boolean, ms = 20_000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0), caps = DEFAULT_CAPS;
const fact = (over: Partial<Fact> = {}): Fact => ({ id: 'r1', projectId: 7, startedMs: NOW - 60_000, endedMs: NOW - 30_000, outcome: 'done', w: 1, usd: 1, sig: '(без текста)', handoffOf: null, ...over });

test('S2: a runaway run (its own cap) ends as guard; a stop for the SHARED day cap or a chain ends as guard-stop, which is neutral', async () => {
  const run = async (reason: unknown): Promise<string | null> => {
    const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
    const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, guard: { usage: () => reason as never }, env: { ...process.env, FAKE_SCENARIO: 'claude-heavy' } });
    const r = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root, model: 'claude-sonnet-5-5' });
    await until(() => !rm.isLive(r.id) && !!rm.get(r.id)?.outcome);
    return rm.get(r.id)!.outcome;
  };
  assert.equal(await run('запуск израсходовал слишком много'), 'guard');
  assert.equal(await run({ reason: 'за сутки израсходовано много', neutral: true }), 'guard-stop');
});

test('S2: a day cap that stops three live runs scores nothing and trips neither same-failure nor repeated-stops, and nothing stays blocked once the day clears', () => {
  const stops = [0, 1, 2].map((i) => fact({ id: `d${i}`, outcome: 'guard-stop', endedMs: NOW - (i + 1) * 60_000, sig: '(остановлено защитой)' }));
  const t = evaluate({ now: NOW, caps, facts: stops });
  assert.ok(t.every((x) => x.kind !== 'same-failure' && x.kind !== 'repeated-stops'), JSON.stringify(t.map((x) => x.kind)));
  const many = Array.from({ length: 8 }, (_, i) => fact({ id: `m${i}`, outcome: 'guard-stop', endedMs: NOW - (i + 1) * 60_000 }));
  assert.ok(evaluate({ now: NOW, caps, facts: many }).every((x) => x.kind !== 'repeated-stops'), 'eight neutral stops are not a loop of the model');
  const fails = (n: number): Fact[] => Array.from({ length: n }, (_, i) => fact({ id: `f${i}`, outcome: 'failed', endedMs: NOW - 400_000 + i * 100_000, sig: 'x' }));
  assert.ok(evaluate({ now: NOW, caps, facts: [...fails(2), ...stops.slice(0, 1)] }).every((x) => x.kind !== 'same-failure'), 'a neutral stop adds nothing to the streak: two failures stay two');
  assert.ok(evaluate({ now: NOW, caps, facts: [fails(3)[0]!, fails(3)[1]!, ...stops.slice(0, 1).map((s) => ({ ...s, endedMs: NOW - 250_000 })), fails(3)[2]!] }).some((x) => x.kind === 'same-failure'), 'and it does not break the streak of real failures around it');
  assert.equal(econ.runScore(econ.settledOutcome('guard-stop', null), null), null, 'no quality score at all');
  assert.equal(econ.runScore(econ.settledOutcome('guard', null), null), 0, 'a runaway run still scores 0');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO run (id, project_id, agent, model, effort, started_at, ended_at, outcome, cls, tokens_in, tokens_cached, tokens_out) VALUES ('rn1', 1, 'claude', 'claude-sonnet-5-5', 'high', ?, ?, 'guard-stop', 'implement', 100, 0, 50)").run(new Date(NOW - 600_000).toISOString(), new Date(NOW - 500_000).toISOString());
  assert.equal(econ.modelStats(db)['implement|sonnet'], undefined, 'it is not in the routing statistics');
  assert.equal(readFacts(db, NOW)[0]!.outcome, 'guard-stop');
});

test('N4: guard-stopped runs stay out of the token profiles; shared cases and the rating route know the new outcomes', async () => {
  const db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO run (id, project_id, agent, model, effort, started_at, ended_at, outcome, cls, tokens_in, tokens_cached, tokens_out, project_type) VALUES (?, 1, 'claude', 'claude-sonnet-5-5', 'high', ?, ?, ?, 'implement', ?, 0, 1000, 'x')");
  for (let i = 0; i < 3; i++) ins.run(`ok${i}`, new Date(NOW - 9e6).toISOString(), new Date(NOW - 8e6).toISOString(), 'done', 1000);
  for (const [i, o] of ['guard', 'guard-stop'].entries()) ins.run(`g${i}`, new Date(NOW - 7e6).toISOString(), new Date(NOW - 6e6).toISOString(), o, 900_000_000);
  const p = econ.effortProfile(db, 'claude', 'high');
  assert.equal(p.n, 3, 'only the three finished runs'); assert.ok(p.p90.uncachedIn < 1e6, 'the runaway tokens did not move the profile');
  assert.ok(buildCases(db).some((c) => c.outcome === 'guard') && buildCases(db).some((c) => c.outcome === 'guard-stop'), 'the shared cases include them (numbers only, rounded)');
  const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
  const M = await import(pathToFileURL(join(web, 'trace-model.js')).href) as { traceModel: (r: unknown) => { run: { outcome: string } } | null };
  void M;
  const { readFileSync } = await import('node:fs');
  for (const f of ['views/common.js', 'transcript.js', 'trace-model.js']) assert.match(readFileSync(join(web, f), 'utf8'), /guard-stop/, f);
});
