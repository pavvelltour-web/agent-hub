import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The user's config is read from the hub home: point it at an empty temp folder BEFORE the modules load, so no test depends on this machine's own settings.
const base = mkdtempSync(join(tmpdir(), 'hub-brk-base-'));
process.env['USERPROFILE'] = base; process.env['HOME'] = base; process.env['AGENT_HUB_HOME'] = join(base, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { CAP_RANGE, DAY_MS, DEFAULT_CAPS, FAILURE_COOLDOWN_MS, STOPS_WINDOW_MS, ackTrip, blockingTrips, capsProblem, chainDepth, effectiveCaps, evaluate, loadAcks, makeGuard, readFacts, readProjectCaps, runOver, sanitizeCaps } = await import('./breaker.ts');
type Fact = import('./breaker.ts').Fact;
const { sealFile } = await import('./integrity.ts');
const { RunManager } = await import('./runner.ts');
const { openDb, projectId } = await import('../history/store.ts');
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const caps = DEFAULT_CAPS;
const fact = (over: Partial<Fact> = {}): Fact => ({ id: 'r1', projectId: 7, startedMs: NOW - 60_000, endedMs: NOW - 30_000, outcome: 'done', w: 1, usd: 1, sig: '(без текста)', handoffOf: null, ...over });
const failed = (id: string, minAgo: number, sig = 'boom: #', pid = 7): Fact => fact({ id, projectId: pid, outcome: 'failed', startedMs: NOW - (minAgo + 1) * 60_000, endedMs: NOW - minAgo * 60_000, sig });

// ---------- caps and who may change them ----------

test('defaults are ON with the documented numbers, inside the ranges the route accepts', () => {
  assert.equal(DEFAULT_CAPS.enabled, true);
  assert.deepEqual(effectiveCaps(undefined).caps, DEFAULT_CAPS);
  assert.deepEqual(effectiveCaps(null, null).caps, DEFAULT_CAPS);
  for (const [k, [lo, hi]] of Object.entries(CAP_RANGE)) { const v = (DEFAULT_CAPS as unknown as Record<string, number>)[k] as number; assert.ok(v >= lo && v <= hi, k); }
});

test('only the boolean false in the USER config switches the protection off; nothing else does', () => {
  assert.equal(effectiveCaps({ enabled: false }).caps.enabled, false);
  for (const v of ['false', 0, null, 'off', [], {}, undefined]) assert.equal(effectiveCaps({ enabled: v }).caps.enabled, true, String(v));
  assert.equal(effectiveCaps(undefined, { enabled: false }).caps.enabled, true, 'a project cannot');
  assert.ok(effectiveCaps(undefined, { enabled: false }).notes.some((n) => /hub\.json не может/.test(n)));
  assert.equal(effectiveCaps({ enabled: true }, { enabled: false, runWeighted: 1 }).caps.enabled, true);
});

test('hub.json can only TIGHTEN: a smaller number wins, a larger one is ignored and named, nonsense is dropped', () => {
  const g = { runWeighted: 20, dayUsd: 100 };
  const lower = effectiveCaps(g, { runWeighted: 5, dayUsd: 50, stopsN: 2 });
  assert.equal(lower.caps.runWeighted, 5); assert.equal(lower.caps.dayUsd, 50); assert.equal(lower.caps.stopsN, 2);
  const higher = effectiveCaps(g, { runWeighted: 200, dayUsd: 999, sameFailureN: 10 });
  assert.equal(higher.caps.runWeighted, 20); assert.equal(higher.caps.dayUsd, 100); assert.equal(higher.caps.sameFailureN, DEFAULT_CAPS.sameFailureN, 'above the default, and the user kept the default');
  assert.equal(higher.notes.length, 3);
  const junk = effectiveCaps(g, { runWeighted: 'huge', dayUsd: Number.NaN, chainMax: Infinity, stopsN: -5, sameFailureN: [1], '__proto__': { enabled: false }, constructor: 1 });
  assert.equal(junk.caps.runWeighted, 20); assert.equal(junk.caps.dayUsd, 100);
  assert.equal(junk.caps.stopsN, CAP_RANGE.stopsN[0], 'a negative number is clamped to the floor, which is a TIGHTER cap');
  assert.equal(junk.caps.enabled, true);
  assert.equal(({} as { enabled?: unknown }).enabled, undefined, 'no prototype pollution');
});

test('the user config is clamped into the ranges when read; the route refuses an out-of-range number instead', () => {
  assert.equal(sanitizeCaps({ runWeighted: 1e12 }).runWeighted, CAP_RANGE.runWeighted[1]);
  assert.equal(sanitizeCaps({ sameFailureN: 3.9 }).sameFailureN, 3);
  assert.deepEqual(sanitizeCaps('x'), {}); assert.deepEqual(sanitizeCaps([1]), {});
  assert.equal(capsProblem({ runWeighted: 10 }), null);
  assert.match(capsProblem({ runWeighted: 1e9 }) ?? '', /from 1 to 75/);
  assert.match(capsProblem({ sameFailureN: 2.5 }) ?? '', /whole number/);
  assert.match(capsProblem({ nope: 1 }) ?? '', /unknown cap/);
  assert.match(capsProblem({ runUsd: '5' }) ?? '', /runUsd/);
  assert.match(capsProblem([]) ?? '', /object/);
});

test('readProjectCaps: reads only an object `guardrails` of a small regular hub.json; a link, a big file, bad JSON give nothing', () => {
  const d = mkdtempSync(join(tmpdir(), 'hub-brk-'));
  try {
    writeFileSync(join(d, 'hub.json'), JSON.stringify({ guardrails: { runWeighted: 3, enabled: false } }));
    assert.deepEqual(readProjectCaps(d), { runWeighted: 3, enabled: false });
    assert.equal(effectiveCaps(undefined, readProjectCaps(d)).caps.enabled, true);
    writeFileSync(join(d, 'hub.json'), JSON.stringify({ guardrails: 'off' })); assert.equal(readProjectCaps(d), undefined);
    writeFileSync(join(d, 'hub.json'), '{bad'); assert.equal(readProjectCaps(d), undefined);
    writeFileSync(join(d, 'hub.json'), JSON.stringify({ guardrails: { runWeighted: 3 }, pad: 'x'.repeat(250_000) })); assert.equal(readProjectCaps(d), undefined);
    const real = join(d, 'real.json'); writeFileSync(real, JSON.stringify({ guardrails: { runWeighted: 3 } })); rmSync(join(d, 'hub.json'));
    try { symlinkSync(real, join(d, 'hub.json')); assert.equal(readProjectCaps(d), undefined, 'a link is not followed'); } catch { /* no symlink right on this machine */ }
    assert.equal(readProjectCaps(join(d, 'nothing')), undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- evaluate (pure, fake clock) ----------

test('run cap: a LIVE run over the token or the cost cap is a trip that names the run; a finished one is not', () => {
  assert.equal(runOver(caps, caps.runWeighted, 1), null, 'exactly at the cap is fine');
  assert.match(runOver(caps, caps.runWeighted + 1, null) ?? '', /условных млн токенов/);
  assert.match(runOver(caps, 1, caps.runUsd + 1) ?? '', /\$/);
  assert.equal(runOver(caps, 1e6, 1e6 as number) !== null, true); assert.equal(runOver({ ...caps, enabled: false }, 1e6, 1e6), null);
  const t = evaluate({ now: NOW, caps, facts: [fact({ id: 'live', outcome: null, endedMs: null, w: 40 }), fact({ id: 'old', w: 400 })] });
  assert.deepEqual(t.filter((x) => x.kind === 'run-cap').map((x) => x.stop), [['live']]);
  assert.equal(t.find((x) => x.kind === 'run-cap')!.blocksStart, false);
});

test('day cap: tokens or dollars over the cap in 24 h block every start and stop live runs; it clears by itself as the day rolls', () => {
  const heavy = [fact({ id: 'a', w: 70, usd: 10, startedMs: NOW - 2 * 3600_000 }), fact({ id: 'b', w: 60, usd: 10, outcome: null, endedMs: null })];
  const t = evaluate({ now: NOW, caps, facts: heavy });
  const d = t.find((x) => x.kind === 'day-cap')!;
  assert.ok(d.blocksStart && d.projectId === undefined); assert.deepEqual(d.stop, ['b']); assert.equal(d.ackable, false);
  assert.ok(evaluate({ now: NOW + DAY_MS, caps, facts: heavy.filter((f) => f.id === 'a') }).every((x) => x.kind !== 'day-cap'), 'a day later the old run no longer counts');
  const usd = evaluate({ now: NOW, caps, facts: [fact({ w: 1, usd: caps.dayUsd + 1 })] });
  assert.ok(usd.some((x) => x.kind === 'day-cap' && /\$/.test(x.ru)));
  assert.equal(evaluate({ now: NOW, caps, facts: [fact({ w: caps.dayWeighted, usd: caps.dayUsd })] }).length, 0, 'exactly at the caps is fine');
  assert.equal(evaluate({ now: NOW, caps: { ...caps, enabled: false }, facts: heavy }).length, 0);
});

test('same failure N times in a row: blocks starts in THAT project until the cooldown passes or the user acknowledges', () => {
  const three = [failed('a', 3), failed('b', 2), failed('c', 1)];
  const t = evaluate({ now: NOW, caps, facts: three });
  const s = t.find((x) => x.kind === 'same-failure')!;
  assert.deepEqual([s.blocksStart, s.projectId, s.ackable, s.key], [true, 7, true, 'same-failure:7']);
  assert.ok(evaluate({ now: NOW, caps, facts: [failed('a', 3), failed('b', 2)] }).every((x) => x.kind !== 'same-failure'), 'two is not three');
  assert.ok(evaluate({ now: NOW, caps, facts: [failed('a', 3, 'boom: #'), failed('b', 2, 'other'), failed('c', 1, 'boom: #')] }).every((x) => x.kind !== 'same-failure'), 'different failures are not the same failure');
  assert.ok(evaluate({ now: NOW, caps, facts: [failed('a', 3), failed('b', 2), fact({ id: 'ok', outcome: 'review', endedMs: NOW - 90_000 }), failed('c', 1)] }).every((x) => x.kind !== 'same-failure'), 'a success in between breaks the run of failures');
  assert.ok(evaluate({ now: NOW, caps, facts: [failed('a', 3), failed('b', 2), failed('u', 1.5), fact({ id: 'st', outcome: 'stopped', endedMs: NOW - 80_000 })] }).some((x) => x.kind === 'same-failure'), 'a manual stop is not a success');
  assert.ok(evaluate({ now: NOW + FAILURE_COOLDOWN_MS, caps, facts: three }).every((x) => x.kind !== 'same-failure'), 'the cooldown passed');
  assert.ok(evaluate({ now: NOW, caps, facts: three, acks: { 'same-failure:7': NOW - 30_000 } }).every((x) => x.kind !== 'same-failure'), 'acknowledged after the last failure');
  assert.ok(evaluate({ now: NOW, caps, facts: [...three, failed('d', 0.1)], acks: { 'same-failure:7': NOW - 30_000 } }).every((x) => x.kind !== 'same-failure'), 'one new failure after an acknowledgement is one');
  assert.ok(evaluate({ now: NOW, caps, facts: [...three, failed('n1', 0.45, 'boom: #'), failed('n2', 0.4, 'boom: #'), failed('n3', 0.3, 'boom: #')], acks: { 'same-failure:7': NOW - 30_000 } }).some((x) => x.kind === 'same-failure'), 'three new ones trip it again');
  assert.equal(evaluate({ now: NOW, caps, facts: three.map((f) => ({ ...f, projectId: 8 })) }).find((x) => x.kind === 'same-failure')?.projectId, 8);
});

test('repeated stops (context or limit) inside an hour block starts in that project; an acknowledgement or an hour clears it', () => {
  const stops = Array.from({ length: caps.stopsN }, (_, i) => fact({ id: `s${i}`, outcome: i % 2 ? 'limit' : 'context', endedMs: NOW - (i + 1) * 60_000 }));
  const t = evaluate({ now: NOW, caps, facts: stops }).find((x) => x.kind === 'repeated-stops')!;
  assert.deepEqual([t.blocksStart, t.projectId, t.ackable], [true, 7, true]);
  assert.ok(evaluate({ now: NOW, caps, facts: stops.slice(1) }).every((x) => x.kind !== 'repeated-stops'));
  assert.ok(evaluate({ now: NOW + STOPS_WINDOW_MS, caps, facts: stops }).every((x) => x.kind !== 'repeated-stops'));
  assert.ok(evaluate({ now: NOW, caps, facts: stops, acks: { 'repeated-stops:7': NOW } }).every((x) => x.kind !== 'repeated-stops'));
});

test('continuation chains: a new continuation of a long chain is refused, a live run deep in a chain is stopped', () => {
  const chain: Fact[] = Array.from({ length: 6 }, (_, i) => fact({ id: `c${i}`, handoffOf: i ? `c${i - 1}` : null, outcome: 'context', endedMs: NOW - 3_000_000 }));
  assert.equal(chainDepth(chain, 'c5'), 6); assert.equal(chainDepth(chain, 'c0'), 1); assert.equal(chainDepth(chain, null), 0);
  const cyc = [fact({ id: 'x', handoffOf: 'y' }), fact({ id: 'y', handoffOf: 'x' })];
  assert.ok(chainDepth(cyc, 'x') <= 2, 'a cycle is cut');
  assert.ok(evaluate({ now: NOW, caps, facts: chain, start: { handoffOf: 'c5' } }).some((x) => x.kind === 'chain' && x.blocksStart), 'a continuation of a chain that already has 6 runs');
  assert.ok(evaluate({ now: NOW, caps, facts: chain, start: { handoffOf: 'c2' } }).every((x) => x.kind !== 'chain'), 'a short chain continues');
  assert.ok(evaluate({ now: NOW, caps, facts: chain, start: {} }).every((x) => x.kind !== 'chain'));
  const live = [...chain, fact({ id: 'c6', handoffOf: 'c5', outcome: null, endedMs: null })];
  assert.deepEqual(evaluate({ now: NOW, caps, facts: live }).find((x) => x.kind === 'chain' && !x.blocksStart)?.stop, ['c6'], 'the 7th run of a chain of at most 6');
  assert.ok(evaluate({ now: NOW, caps, facts: [...chain.slice(0, 5), fact({ id: 'c5', handoffOf: 'c4', outcome: null, endedMs: null })] }).every((x) => x.kind !== 'chain'), 'the 6th run is still allowed');
});

// ---------- the run table ----------

test('readFacts: weighted tokens, own cost, a failure signature without paths or numbers, a live run kept', () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out, cost_usd, error, handoff_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('ra', 1, 'claude', new Date(NOW - 3600_000).toISOString(), new Date(NOW - 3000_000).toISOString(), 'failed', 2_000_000, 1_000_000, 100_000, 3.5, "ENOENT: no such file 'C:\\Users\\a\\x.ts' at line 42", null);
  ins.run('rb', 1, 'claude', new Date(NOW - 4 * DAY_MS).toISOString(), null, null, null, null, null, null, null, null);
  ins.run('rc', 1, 'claude', new Date(NOW - 4 * DAY_MS).toISOString(), new Date(NOW - 4 * DAY_MS + 1000).toISOString(), 'done', 5, 5, 5, null, null, null);
  const f = readFacts(db, NOW), a = f.find((x) => x.id === 'ra')!;
  assert.equal(Math.round(a.w * 100) / 100, 1.6, 'uncached 1M + 0.1 x cached 1M + 5 x out 0.1M');
  assert.equal(a.usd, 3.5); assert.equal(a.sig, "enoent: no such file '<path>' at line #");
  assert.ok(f.some((x) => x.id === 'rb' && x.outcome === null), 'a run that never ended is kept however old');
  assert.ok(!f.some((x) => x.id === 'rc'), 'a finished run older than three days is not');
});

// ---------- acknowledgements ----------

test('acknowledgements: only same-failure and repeated-stops of a numeric project can be acknowledged; a cap cannot be waved away', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-brk-home-'));
  try {
    assert.equal(ackTrip(home, 'day-cap', NOW), false); assert.equal(ackTrip(home, 'run-cap:r1', NOW), false); assert.equal(ackTrip(home, '../../x', NOW), false); assert.equal(ackTrip(home, 'same-failure:7; rm', NOW), false);
    assert.equal(ackTrip(home, 'same-failure:7', NOW), true); assert.equal(ackTrip(home, 'repeated-stops:8', NOW + 5), true);
    assert.deepEqual(loadAcks(home), { 'same-failure:7': NOW, 'repeated-stops:8': NOW + 5 });
    writeFileSync(join(home, 'guardrails.json'), JSON.stringify({ acks: { 'day-cap': 1, 'same-failure:7': 'x', 'same-failure:9': -1, 'same-failure:10': 5 } })); sealFile(home, 'guardrails.json');   // as if the hub had written it: this tests the validation, integrity.test.ts tests the seal
    assert.deepEqual(loadAcks(home), { 'same-failure:10': 5 });
    writeFileSync(join(home, 'guardrails.json'), 'x'.repeat(200_000)); sealFile(home, 'guardrails.json'); assert.deepEqual(loadAcks(home), {});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------- the guard the RunManager asks ----------

test('makeGuard.start: a tripped breaker refuses with a Russian reason, only for the folder it concerns; a project file cannot lift it', () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(tmpdir(), 'hub-brk-home-')), a = mkdtempSync(join(tmpdir(), 'hub-brk-a-')), b = mkdtempSync(join(tmpdir(), 'hub-brk-b-'));
  try {
    const pa = projectId(db, a) as number, pb = projectId(db, b) as number;
    const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, error) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 3; i++) ins.run(`rf${i}`, pa, 'claude', new Date(NOW - (i + 2) * 60_000).toISOString(), new Date(NOW - (i + 1) * 60_000).toISOString(), 'failed', 'same boom');
    const g = makeGuard({ db, home, now: () => NOW, userCaps: () => undefined, projectCaps: () => ({ enabled: false, sameFailureN: 99 }) });
    assert.match(g.start!({ agent: 'claude', prompt: 'x', projectRoot: a }) ?? '', /^Защита от лишних запусков: одна и та же ошибка 3 раза подряд/);
    assert.equal(g.start!({ agent: 'claude', prompt: 'x', projectRoot: b }), null, 'another project is not blocked');
    assert.equal(blockingTrips(db, home, a, { now: NOW, userCaps: undefined, projectCaps: { enabled: false } }).length, 1);
    assert.equal(blockingTrips(db, home, b, { now: NOW, userCaps: undefined, projectCaps: undefined }).length, 0);
    ackTrip(home, `same-failure:${pa}`, NOW - 30_000);
    assert.equal(g.start!({ agent: 'claude', prompt: 'x', projectRoot: a }), null, 'the user looked at it');
    const off = makeGuard({ db, home, now: () => NOW, userCaps: () => ({ enabled: false }), projectCaps: () => undefined });
    ins.run('rg', pb, 'claude', new Date(NOW - 60_000).toISOString(), null, null, null);
    db.prepare('UPDATE run SET tokens_out = 100000000 WHERE id = ?').run('rg');
    assert.match(g.start!({ agent: 'claude', prompt: 'x', projectRoot: b }) ?? '', /за сутки израсходовано/, 'the day cap is global');
    assert.equal(off.start!({ agent: 'claude', prompt: 'x', projectRoot: b }), null, 'only the user switched it off');
  } finally { for (const d of [home, a, b]) rmSync(d, { recursive: true, force: true }); }
});

test('n2: the ceiling of every cap is 3 times its default (10 times was a click away from "off in practice")', () => {
  for (const k of Object.keys(CAP_RANGE) as (keyof typeof CAP_RANGE)[]) assert.equal(CAP_RANGE[k][1], 3 * (DEFAULT_CAPS as unknown as Record<string, number>)[k]!, k);
  assert.equal(sanitizeCaps({ runWeighted: 250, stopsN: 20 }).runWeighted, 75);
  assert.match(capsProblem({ dayWeighted: 361 }) ?? '', /from 1 to 360/);
});

test('n6: a live run deep in a continuation chain is stopped by usage(), not only listed', () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-'));
  const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, outcome, handoff_of) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 8; i++) ins.run(`c${i}`, 1, 'claude', new Date(NOW - (9 - i) * 60_000).toISOString(), i < 7 ? 'context' : null, i ? `c${i - 1}` : null);
  const g = makeGuard({ db, home, now: () => NOW, userCaps: () => undefined, projectCaps: () => undefined });
  const why = (x: unknown): string => (typeof x === 'string' ? x : (x as { reason?: string } | null)?.reason ?? '');
  assert.match(why(g.usage!({ runId: 'c7', projectRoot: 'x', weighted: 0, costUsd: null })), /цепочка продолжений дошла до 8/);
  assert.equal(typeof g.usage!({ runId: 'c7', projectRoot: 'x', weighted: 0, costUsd: null }), 'object', 'a chain stop is neutral for the model: it comes as an object, not as a plain string');
  assert.equal(g.usage!({ runId: 'c5', projectRoot: 'x', weighted: 0, costUsd: null }), null, 'the 6th run of a chain is still allowed');
  assert.equal(g.usage!({ runId: 'nothing', projectRoot: 'x', weighted: 0, costUsd: null }), null);
});

test('makeGuard.usage: the per-run cap, then the day cap counting the other runs; a project file can only lower the caps', () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(tmpdir(), 'hub-brk-home-'));
  try {
    db.prepare('INSERT INTO run (id, project_id, agent, started_at, outcome, tokens_in, tokens_cached, tokens_out) VALUES (?,?,?,?,?,?,?,?)').run('other', 1, 'claude', new Date(NOW - 3600_000).toISOString(), 'done', 100_000_000, 0, 0);
    const g = makeGuard({ db, home, now: () => NOW, userCaps: () => ({ runWeighted: 20, dayWeighted: 100 }), projectCaps: () => ({ runWeighted: 10, dayWeighted: 99999 }) });
    assert.match(g.usage!({ runId: 'me', projectRoot: 'x', weighted: 11, costUsd: null }) as string, /при пороге 10/, 'the project lowered the run cap to 10');
    const day = g.usage!({ runId: 'me', projectRoot: 'x', weighted: 5, costUsd: null });
    assert.match(typeof day === 'string' ? day : day?.reason ?? '', /за сутки израсходовано 105/, 'the other run (100) plus this one; the project could not raise the day cap');
    assert.equal(typeof day, 'object', 'a day-cap stop is neutral for the model');
    assert.equal(g.usage!({ runId: 'other', projectRoot: 'x', weighted: 5, costUsd: null }), null, 'the run itself is not counted twice');
    assert.equal(makeGuard({ db, home, now: () => NOW, userCaps: () => ({ enabled: false }), projectCaps: () => undefined }).usage!({ runId: 'me', projectRoot: 'x', weighted: 1e6, costUsd: 1e6 }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------- the RunManager: the guard is ON by default, refuses a start, and stops a runaway run ----------

const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const until = async (fn: () => boolean, ms = 20_000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

test('RunManager: a guard that says no stops the start before anything is created (no run row, no worktree)', () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, guard: { start: () => 'Защита от лишних запусков: проверка' } });
  assert.throws(() => rm.start({ agent: 'claude', prompt: 'x', projectRoot: root }), /Защита от лишних запусков: проверка/);
  assert.equal(rm.list().length, 0);
});

test('RunManager: the guard is ON when nothing is passed: three identical failures in a project block the fourth start; guard: false is the explicit test switch', () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
  const pid = projectId(db, root) as number, now = Date.now();
  const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, error) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 3; i++) ins.run(`rf${i}`, pid, 'claude', new Date(now - (i + 2) * 60_000).toISOString(), new Date(now - (i + 1) * 60_000).toISOString(), 'failed', 'same boom');
  const on = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home });
  assert.throws(() => on.start({ agent: 'claude', prompt: 'x', projectRoot: root }), /Защита от лишних запусков: одна и та же ошибка 3 раза подряд/);
  const off = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, guard: false, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' } });
  assert.doesNotThrow(() => off.start({ agent: 'claude', prompt: 'x', projectRoot: root }));
});

test('RunManager: a run that passes the per-run cap while it works is stopped by the hub: outcome guard, one explaining warn, the process gone', async () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
  const guard = makeGuard({ db, home, userCaps: () => ({ runWeighted: 20 }), projectCaps: () => undefined });
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, guard, env: { ...process.env, FAKE_SCENARIO: 'claude-heavy' } });
  const run = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root, model: 'claude-sonnet-5-5' });
  await until(() => !rm.isLive(run.id) && !!rm.get(run.id)?.outcome);
  assert.equal(rm.get(run.id)!.outcome, 'guard', 'a distinct outcome: counted as a failure for quality, not hidden as a manual stop');
  const warns = rm.events(run.id).filter((e) => e.kind === 'warn').map((e) => (e.data as { message: string }).message);
  assert.equal(warns.filter((w) => /остановлено защитой/.test(w)).length, 1);
  assert.ok(warns.some((w) => /условных млн токенов при пороге 20/.test(w)));
  assert.ok(!warns.some((w) => w === 'stopped by user'), 'the user did not stop it');
});

test('RunManager: a guard that throws never breaks the run', async () => {
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, guard: { usage: () => { throw new Error('guard bug'); } }, env: { ...process.env, FAKE_SCENARIO: 'claude-trace' } });
  const run = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root });
  await until(() => !rm.isLive(run.id) && !!rm.get(run.id)?.outcome);
  assert.equal(rm.get(run.id)!.outcome, 'done', 'a broken guard is not a reason to kill work');
});

test('request bodies and project files cannot loosen the guard: the run routes never read caps, and hub.json only tightens', async () => {
  const { handle } = await import('../server/api.ts');
  const db = openDb(':memory:'), home = mkdtempSync(join(base, 'h-')), root = mkdtempSync(join(base, 'p-'));
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ guardrails: { enabled: false, runWeighted: 250, dayWeighted: 1200, sameFailureN: 10 } }));
  const pid = projectId(db, root) as number, now = Date.now();
  const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, error) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 3; i++) ins.run(`rf${i}`, pid, 'claude', new Date(now - (i + 2) * 60_000).toISOString(), new Date(now - (i + 1) * 60_000).toISOString(), 'failed', 'same boom');
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home });
  const res = await handle({ db, runs: rm } as never, 'POST', '/api/runs', new URLSearchParams(), { prompt: 'x', projectId: pid, agent: 'claude', guardrails: { enabled: false }, caps: { sameFailureN: 99 }, guard: false, enabled: false, runWeighted: 9999 });
  assert.equal(res.status, 400);
  assert.match((res.json as { error: string }).error, /Защита от лишних запусков/, 'hub.json with enabled:false and bigger numbers, and a body that says the same, changed nothing');
  assert.equal(rm.list().length, 3, 'no new run: only the three seeded failures are there');
});

// ---------- the panel's data layer ----------

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const G = await import(pathToFileURL(join(web, 'guard-model.js')).href) as { guardModel: (r: unknown) => any; effortText: (e: string) => string };

test('panel data layer: a hostile answer is typed; unknown trips are dropped; only a well-formed key can be acknowledged; text is plain', () => {
  assert.equal(G.guardModel(null), null); assert.equal(G.guardModel([]), null);
  const m = G.guardModel({ enabled: false, usage: { dayWeighted: 'x', dayUsd: 12.5 }, caps: { runWeighted: 25, runUsd: 'x' }, ranges: { runWeighted: { min: 1, max: 250 }, dayUsd: { min: 'a', max: 1 } }, notes: ['<b>n</b>‮', 5],
    tamper: [{ file: 'autouse.json‮', at: 'x' }, { file: 5 }, null], trips: [{ kind: 'same-failure', key: 'same-failure:7', ru: '<script>alert(1)</script>​', slug: '<img onerror=1>', ackable: true }, { kind: 'same-failure', key: '../../x', ru: 'x', ackable: true }, { kind: 'day-cap', key: 'day-cap', ru: 'cap', ackable: true },
      { kind: 'wipe', key: 'wipe', ru: 'x' }, { kind: 'chain', key: 'chain:start', ru: '' }, null, 'x'], review: { tightened: 'yes', flagReviewer: true, why: 'w‮', reviewEffort: 'rm -rf' } });
  assert.equal(m.enabled, false); assert.deepEqual(m.usage, { weighted: 0, usd: 12.5 });
  assert.equal(m.caps.runWeighted, 25); assert.equal(m.caps.runUsd, null); assert.deepEqual(m.ranges.runWeighted, { min: 1, max: 250 }); assert.equal(m.ranges.dayUsd, null);
  assert.deepEqual(m.trips.map((t: { kind: string; ackable: boolean }) => [t.kind, t.ackable]), [['same-failure', true], ['same-failure', false], ['day-cap', false]], 'a malformed key or a cap trip is never ackable');
  assert.ok(!/[​‮]/.test(m.trips[0].ru) && !/[‮]/.test(m.notes[0]) && !/[‮]/.test(m.review.why));
  assert.equal(m.review.tightened, false, 'the string "yes" is not true'); assert.equal(m.review.flag, true); assert.equal(m.review.effort, 'standard');
  assert.equal(G.effortText('deep'), 'глубокое');
  assert.deepEqual(m.tamper, ['autouse.json'], 'tamper names are plain text; a non-string entry is dropped');
  assert.deepEqual(G.guardModel({}).tamper, []);
  assert.equal(G.guardModel({}).enabled, true, 'an answer without the field is not "off"');
});

// ---------- review fix 7: a breaker stop has its own outcome and is never invisible ----------

test('guard stops count: ten of them in an hour trip repeated-stops; three in a row are the same failure', () => {
  const guards = Array.from({ length: 10 }, (_, i) => fact({ id: `g${i}`, outcome: 'guard', endedMs: NOW - (i + 1) * 5 * 60_000 + 4 * 60_000, sig: '(остановлено защитой)' }));
  const stops = evaluate({ now: NOW, caps, facts: guards.slice(0, 5) });
  assert.ok(stops.some((x) => x.kind === 'repeated-stops' && x.blocksStart), 'five guard stops within 45 minutes');
  assert.ok(evaluate({ now: NOW, caps, facts: guards }).some((x) => x.kind === 'repeated-stops'), 'all ten');
  assert.ok(evaluate({ now: NOW, caps, facts: guards.slice(0, 2) }).every((x) => x.kind !== 'repeated-stops'), 'two are not a loop');
  const three = [0, 1, 2].map((i) => fact({ id: `s${i}`, outcome: 'guard', endedMs: NOW - (i + 1) * 60_000, sig: '(остановлено защитой)' }));
  assert.ok(evaluate({ now: NOW, caps, facts: three }).some((x) => x.kind === 'same-failure'), 'three guard stops in a row');
  assert.ok(evaluate({ now: NOW, caps, facts: [...three.slice(0, 2), fact({ id: 'u', outcome: 'stopped', endedMs: NOW - 3 * 60_000 }), ...three.slice(2)] }).some((x) => x.kind === 'same-failure'), 'a manual stop between them does not break the streak');
  assert.ok(evaluate({ now: NOW, caps, facts: [...three, fact({ id: 'ok', outcome: 'review', endedMs: NOW - 30_000 })] }).every((x) => x.kind !== 'same-failure'), 'a success does');
});

test('guard outcome in the run table: a failure signature of its own, and the routing quality sees a failure', async () => {
  const econ = await import('../econ/econ.ts');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO run (id, project_id, agent, model, effort, started_at, ended_at, outcome, cls, tokens_in, tokens_cached, tokens_out) VALUES ('rg1', 1, 'claude', 'claude-sonnet-5-5', 'high', ?, ?, 'guard', 'implement', 100, 0, 50)").run(new Date(NOW - 600_000).toISOString(), new Date(NOW - 500_000).toISOString());
  assert.equal(readFacts(db, NOW)[0]!.sig, '(остановлено защитой)');
  assert.equal(econ.settledOutcome('guard', null), 'failed');
  assert.equal(econ.runScore(econ.settledOutcome('guard', null), null), 0, 'a runaway run scores zero, like a failed one');
  assert.equal(econ.modelStats(db)['implement|sonnet']?.n, 1); assert.equal(econ.modelStats(db)['implement|sonnet']?.score, 0);
  const row = econ.outcomes(db).find((r: { cls: string }) => r.cls === 'implement')!;
  assert.deepEqual([row.runs, row.failed, row.done], [1, 1, 0]);
});

test('the panel names the guard outcome in both label maps', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['views/common.js', 'transcript.js']) assert.match(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js', f), 'utf8'), /guard: \[?'/, f);
});
