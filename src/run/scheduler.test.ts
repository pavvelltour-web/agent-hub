import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPROVAL_TTL_MS, MAX_STARTS_PER_DAY, MIN_LEFT_PCT, SAFETY_MARGIN_PCT, billingOk, startReqFor, suggestBeforeReset, validJob, type QueuedJob } from './scheduler.ts';
import { startAutoLoop, hasPending } from './autouse-wire.ts';
import { AutoScheduler, confirmWordFor, loadAuto, setEnabled, approveItem, cancelItem, saveAuto, projectKeyOf, type AutoDeps } from './autouse.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'autouse-model.js')).href) as { autoModel: (r: unknown) => any; suggestionLine: (s: any) => string; hoursText: (h: number) => string; confirmMatches: (a: unknown, b: unknown) => boolean };
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const sec = NOW / 1000;
const job = (over: Partial<QueuedJob> = {}): QueuedJob => ({ id: 'j1', kind: 'review-existing', projectId: 1, agent: 'codex', expectedPct: 12, writes: 'none', ...over });
const lim = (used: number | null, resetsInH: number | null, over: Record<string, unknown> = {}) => ({ usedPercent: used, reached: false, resetsAt: resetsInH == null ? null : sec + resetsInH * 3600, ...over });

// ---------- suggestBeforeReset (pure) ----------

test('suggestBeforeReset: a job fits when enough is left, the reset is near and the limit reading is known', () => {
  const r = suggestBeforeReset({ limits: { codex: lim(60, 9) }, queue: [job()], now: NOW });
  assert.deepEqual(r.map((j) => j.id), ['j1']);
});

test('suggestBeforeReset: nothing under 20 % left, nothing when the reset is more than 24 h away, nothing when either is unknown', () => {
  assert.equal(MIN_LEFT_PCT, 20);
  const none = (limits: Record<string, unknown>): number => suggestBeforeReset({ limits: limits as never, queue: [job({ expectedPct: 1 })], now: NOW }).length;
  assert.equal(none({ codex: lim(81, 9) }), 0, '19 % left');
  assert.equal(none({ codex: lim(80, 9) }), 1, 'exactly 20 % left is enough');
  assert.equal(none({ codex: lim(40, 24.5) }), 0, 'reset in 24.5 h');
  assert.equal(none({ codex: lim(40, 24) }), 1);
  assert.equal(none({ codex: lim(null, 9) }), 0, 'used percent unknown');
  assert.equal(none({ codex: lim(40, null) }), 0, 'reset time unknown');
  assert.equal(none({ codex: lim(40, -1) }), 0, 'reset already passed: the reading is stale');
  assert.equal(none({ codex: { ...lim(40, 9), reached: true } }), 0, 'limit reached');
  assert.equal(none({}), 0, 'no reading at all');
  assert.equal(none({ claude: lim(10, 5) }), 0, 'a reading of another agent says nothing about codex');
  assert.equal(none({ codex: lim(Number.NaN, 9) }), 0);
  assert.equal(none({ codex: lim(-5, 9) }), 0, 'a nonsense percent is unknown, not "everything left"');
  assert.equal(none({ codex: lim(140, 9) }), 0);
});

test('suggestBeforeReset: a stale reading (older than 2 h) counts as unknown', () => {
  const old = new Date(NOW - 3 * 3600_000).toISOString(), fresh = new Date(NOW - 10 * 60_000).toISOString();
  assert.equal(suggestBeforeReset({ limits: { codex: lim(40, 9, { ts: old }) }, queue: [job()], now: NOW }).length, 0);
  assert.equal(suggestBeforeReset({ limits: { codex: lim(40, 9, { ts: fresh }) }, queue: [job()], now: NOW }).length, 1);
});

test('suggestBeforeReset: stops at a safety margin and shares one budget between jobs', () => {
  assert.equal(SAFETY_MARGIN_PCT, 10);
  const q = [job({ id: 'a', expectedPct: 15 }), job({ id: 'b', expectedPct: 15 }), job({ id: 'c', expectedPct: 15 })];
  const r = suggestBeforeReset({ limits: { codex: lim(30, 5) }, queue: q, now: NOW });   // 70 left, margin 10: 60 usable = 4 x 15, but only 3 asked
  assert.deepEqual(r.map((j) => j.id), ['a', 'b', 'c']);
  const tight = suggestBeforeReset({ limits: { codex: lim(65, 5) }, queue: q, now: NOW });   // 35 left, 25 usable: one job (15) fits, the second would leave 5 < margin
  assert.deepEqual(tight.map((j) => j.id), ['a']);
  assert.deepEqual(suggestBeforeReset({ limits: { codex: lim(65, 5) }, queue: [job({ expectedPct: 26 })], now: NOW }), [], '26 + 10 > 35');
});

test('suggestBeforeReset: write work is never on the main branch, and a job whose writes do not match its kind is dropped', () => {
  const hostile = [
    job({ id: 'x1', writes: 'main' as never }), job({ id: 'x2', kind: 'review-existing', writes: 'branch' }), job({ id: 'x3', kind: 'missing-tests', writes: 'none' }),
    job({ id: 'x4', kind: 'wipe-everything' as never }), job({ id: 'x5', expectedPct: Number.NaN }), job({ id: 'x6', expectedPct: -3 }), job({ id: 'x7', agent: 'gemini' as never }), job({ id: 'x8', projectId: 1.5 }),
    null as never, 'job' as never, job({ id: 'ok', kind: 'missing-tests', writes: 'branch' }),
  ];
  assert.deepEqual(suggestBeforeReset({ limits: { codex: lim(10, 5) }, queue: hostile, now: NOW }).map((j) => j.id), ['ok']);
  assert.equal(validJob(job()), true); assert.equal(validJob({ ...job(), writes: 'main' }), false);
});

// ---------- opt-in, approval and the tick (injected clock, fake spawner, no timers) ----------

function rig(opts: { now?: () => number; limits?: Record<string, unknown>; billing?: (a: string) => { ok: boolean; why?: string }; breaker?: (root: string) => string | null; live?: Set<string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hub-auto-'));
  const root = mkdtempSync(join(tmpdir(), 'hub-auto-root-'));
  const calls = { start: [] as { job: QueuedJob; root: string }[], stop: [] as string[] };
  let clock = NOW;
  const live = opts.live ?? new Set<string>();
  const deps: AutoDeps = {
    home, now: opts.now ?? (() => clock),
    limits: () => (opts.limits ?? { codex: { ...lim(40, 6), ts: new Date(clock).toISOString() } }) as never,
    billing: opts.billing ?? (() => ({ ok: true })),
    breaker: opts.breaker ?? (() => null),
    projectRoot: (id) => (id === 1 ? root : undefined),
    start: (j, r) => { calls.start.push({ job: j, root: r }); const runId = `rauto${calls.start.length}`; live.add(runId); return { runId }; },
    stop: (id) => { calls.stop.push(id); live.delete(id); },
    runState: (id) => ({ live: live.has(id), outcome: live.has(id) ? null : 'review' }),
  };
  return { home, root, deps, calls, live, advance: (ms: number) => { clock += ms; }, done: () => { for (const d of [home, root]) rmSync(d, { recursive: true, force: true }); } };
}
const optIn = (r: ReturnType<typeof rig>): void => { setEnabled(r.home, r.root, true, NOW); };
const approve = (r: ReturnType<typeof rig>, over: Partial<QueuedJob> = {}): string => approveItem(r.home, { ...job(), ...over }, r.root, NOW).id;

test('default OFF: with no toggle nothing starts, even for an approved item, and a hub.json that says "enabled" changes nothing', () => {
  const r = rig();
  try {
    // an approved item with no switch (a file edited by hand, or left from before the project was switched off) is dormant: nothing starts
    saveAuto(r.home, { version: 1, projects: {}, starts: [], items: [{ ...job(), projectKey: projectKeyOf(r.root), projectRoot: r.root, approvedAt: NOW, status: 'approved' }] });
    writeFileSync(join(r.root, 'hub.json'), JSON.stringify({ autouse: { enabled: true }, autoUse: true, 'use-leftover-limit': true }));
    const s = new AutoScheduler(r.deps);
    const rep = s.tick();
    assert.equal(r.calls.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'not-enabled'));
    assert.equal(loadAuto(r.home).projects[Object.keys(loadAuto(r.home).projects)[0] ?? '']?.enabled ?? false, false);
  } finally { r.done(); }
});

test('toggle ON and an approved item: one tick starts exactly one run through the injected spawner with a bounded StartReq', () => {
  const r = rig();
  try {
    optIn(r);
    const id = approve(r);
    approve(r, { id: 'second' });
    const s = new AutoScheduler(r.deps);
    const rep = s.tick();
    assert.equal(r.calls.start.length, 1, 'one run per tick');
    assert.equal(r.calls.start[0]!.root, r.root);
    assert.deepEqual(rep.started.map((x) => x.itemId), [id]);
    assert.equal(loadAuto(r.home).items.find((i) => i.id === id)!.status, 'started');
    s.tick();
    assert.equal(r.calls.start.length, 1, 'the next tick does not start a second run while one is live');
    const req = startReqFor(job(), r.root);
    assert.equal(req.permission, 'plan'); assert.equal(req.workMode, 'review'); assert.equal(req.projectRoot, r.root);
    assert.ok(!('extraArgs' in req) && !('isolatedCwd' in req) && !('autoContinue' in req), 'no internal-only field is ever set');
    const write = startReqFor(job({ kind: 'missing-tests', writes: 'branch' }), r.root);
    assert.equal(write.mode, 'task', 'write work goes through a worktree branch, never the main folder');
    assert.equal(write.permission, 'edit');
  } finally { r.done(); }
});

test('a finished run is recorded; the next approved item then starts on a later tick', () => {
  const r = rig();
  try {
    optIn(r); approve(r); approve(r, { id: 'second' });
    const s = new AutoScheduler(r.deps);
    s.tick(); r.live.clear();
    s.tick();
    const items = loadAuto(r.home).items;
    assert.equal(items.find((i) => i.status === 'finished')?.outcome, 'review');
    assert.equal(r.calls.start.length, 2, 'the freed slot is used by the second item');
  } finally { r.done(); }
});

test('never when a limit is unknown, stale, reached or too small; the item stays queued and nothing starts', () => {
  for (const [name, limits] of [['unknown', {}], ['no percent', { codex: lim(null, 6) }], ['reached', { codex: { ...lim(100, 6), reached: true } }], ['small', { codex: lim(85, 6) }], ['far', { codex: lim(40, 30) }], ['stale', { codex: { ...lim(40, 6), ts: new Date(NOW - 5 * 3600_000).toISOString() } }]] as [string, Record<string, unknown>][]) {
    const r = rig({ limits });
    try {
      optIn(r); approve(r);
      const rep = new AutoScheduler(r.deps).tick();
      assert.equal(r.calls.start.length, 0, name);
      assert.ok(rep.skipped.length > 0, name);
      assert.equal(loadAuto(r.home).items[0]!.status, 'approved', `${name}: still waiting, not lost`);
    } finally { r.done(); }
  }
});

test('never a paid API-key run: an agent that is not clearly on a subscription login does not start', () => {
  assert.deepEqual(billingOk('claude', { loggedIn: true, how: 'claude.ai' }, {}), { ok: true });
  assert.deepEqual(billingOk('codex', { loggedIn: true, how: 'ChatGPT' }, {}), { ok: true });
  for (const how of ['api_key', 'ANTHROPIC_API_KEY', 'an API key', '', 'account', 'bedrock', 'vertex', 'console']) assert.equal(billingOk('claude', { loggedIn: true, how }, {}).ok, false, how);
  assert.equal(billingOk('codex', { loggedIn: true, how: 'an API key' }, {}).ok, false);
  assert.equal(billingOk('claude', { loggedIn: false, how: 'claude.ai' }, {}).ok, false);
  assert.equal(billingOk('claude', undefined, {}).ok, false, 'auth unknown');
  assert.equal(billingOk('claude', { loggedIn: null, how: 'claude.ai' }, {}).ok, false);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) assert.equal(billingOk('claude', { loggedIn: true, how: 'claude.ai' }, { [k]: '1' }).ok, false, `${k} in the environment`);
  assert.equal(billingOk('claude', { loggedIn: true, how: 'claude.ai' }, { ANTHROPIC_API_KEY: '' }).ok, true, 'an empty variable is not a key');
  const r = rig({ billing: () => ({ ok: false, why: 'api key' }) });
  try { optIn(r); approve(r); new AutoScheduler(r.deps).tick(); assert.equal(r.calls.start.length, 0); } finally { r.done(); }
});

test('the circuit breaker blocks the scheduler: a tripped breaker means no start', () => {
  const r = rig({ breaker: () => 'защита остановила запуски' });
  try { optIn(r); approve(r); const rep = new AutoScheduler(r.deps).tick(); assert.equal(r.calls.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'breaker')); } finally { r.done(); }
});

test('an approval expires after 48 h and is then never started', () => {
  let t = NOW;
  const r = rig({ now: () => t });
  try {
    optIn(r); const id = approve(r);
    t = NOW + APPROVAL_TTL_MS + 1;
    r.deps.limits = () => ({ codex: { ...lim(40, 6), resetsAt: t / 1000 + 6 * 3600, ts: new Date(t).toISOString() } }) as never;
    const rep = new AutoScheduler(r.deps).tick();
    assert.equal(r.calls.start.length, 0); assert.deepEqual(rep.expired, [id]);
    assert.equal(loadAuto(r.home).items[0]!.status, 'expired');
  } finally { r.done(); }
});

test('at most 3 starts in 24 hours', () => {
  assert.equal(MAX_STARTS_PER_DAY, 3);
  let t = NOW;
  const r = rig({ now: () => t });
  try {
    optIn(r);
    for (let i = 0; i < 5; i++) approve(r, { id: `j${i}` });
    const s = new AutoScheduler(r.deps);
    for (let i = 0; i < 5; i++) { r.deps.limits = () => ({ codex: { ...lim(40, 6), resetsAt: t / 1000 + 6 * 3600, ts: new Date(t).toISOString() } }) as never; s.tick(); r.live.clear(); t += 60_000; }
    assert.equal(r.calls.start.length, 3);
  } finally { r.done(); }
});

test('a live auto run is stopped when the limit left falls under the safety margin, or the reading turns unknown', () => {
  let t = NOW, used = 40;
  const r = rig({ now: () => t });
  try {
    optIn(r); const id = approve(r);
    r.deps.limits = () => ({ codex: { ...lim(used, 6), resetsAt: t / 1000 + 6 * 3600, ts: new Date(t).toISOString() } }) as never;
    const s = new AutoScheduler(r.deps);
    s.tick(); assert.equal(r.calls.start.length, 1);
    used = 85; t += 60_000;   // 15 left: above the margin of 10
    s.tick(); assert.equal(r.calls.stop.length, 0);
    used = 91; t += 60_000;   // 9 left: under the margin
    const rep = s.tick();
    assert.deepEqual(r.calls.stop, ['rauto1']); assert.equal(rep.stopped[0]!.itemId, id);
    assert.equal(loadAuto(r.home).items[0]!.status, 'stopped');
  } finally { r.done(); }
  const u = rig();
  try {
    optIn(u); approve(u);
    const s = new AutoScheduler(u.deps); s.tick();
    u.deps.limits = () => ({}) as never;
    s.tick();
    assert.deepEqual(u.calls.stop, ['rauto1'], 'a limit that cannot be read is treated as nothing left');
  } finally { u.done(); }
});

test('turning the toggle off cancels what was approved and stops nothing else; an approval for a project that is off is refused', () => {
  const r = rig();
  try {
    optIn(r); const id = approve(r);
    setEnabled(r.home, r.root, false, NOW);
    assert.equal(loadAuto(r.home).items.find((i) => i.id === id)!.status, 'cancelled');
    assert.throws(() => approveItem(r.home, job(), r.root, NOW), /not enabled/);
    new AutoScheduler(r.deps).tick(); assert.equal(r.calls.start.length, 0);
    optIn(r); const id2 = approve(r, { id: 'j2' });
    assert.equal(cancelItem(r.home, id2), true); assert.equal(cancelItem(r.home, id2), false);
  } finally { r.done(); }
});

test('the project that moved or vanished is not started in a different folder', () => {
  const r = rig();
  try {
    optIn(r); approve(r);
    r.deps.projectRoot = () => join(tmpdir(), 'somewhere-else');
    new AutoScheduler(r.deps).tick(); assert.equal(r.calls.start.length, 0);
    r.deps.projectRoot = () => undefined;
    new AutoScheduler(r.deps).tick(); assert.equal(r.calls.start.length, 0);
  } finally { r.done(); }
});

test('a spawner that throws marks the item failed and the scheduler keeps going; graph-refresh is never auto-started', () => {
  const r = rig();
  try {
    optIn(r); const id = approve(r);
    r.deps.start = () => { throw new Error('guardrail: day cap'); };
    const rep = new AutoScheduler(r.deps).tick();
    assert.equal(rep.started.length, 0);
    const it = loadAuto(r.home).items.find((i) => i.id === id)!;
    assert.equal(it.status, 'failed-to-start'); assert.match(it.note ?? '', /guardrail/);
  } finally { r.done(); }
  const g = rig();
  try { optIn(g); approve(g, { kind: 'graph-refresh', writes: 'none' }); new AutoScheduler(g.deps).tick(); assert.equal(g.calls.start.length, 0); } finally { g.done(); }
});

test('the state file: hostile content never enables anything, is size-capped and written atomically', () => {
  const r = rig();
  try {
    const file = join(r.home, 'autouse.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: { x: { enabled: 'yes' }, y: { enabled: true, root: 5 }, z: 7 }, items: [{ status: 'approved', writes: 'main' }, 'x', null, { id: 'q', kind: 'missing-tests', writes: 'main', status: 'approved' }], starts: ['a', -1, 5] }));
    const st = loadAuto(r.home);
    assert.deepEqual(Object.values(st.projects).filter((p) => p.enabled), [], 'no row with a loose "enabled" counts');
    assert.equal(st.items.length, 0); assert.deepEqual(st.starts, [5]);
    writeFileSync(file, 'x'.repeat(2_000_000));
    assert.deepEqual(loadAuto(r.home).items, []);
    writeFileSync(file, '{not json');
    assert.deepEqual(loadAuto(r.home).projects, {});
    saveAuto(r.home, { version: 1, projects: {}, items: [], starts: [] });
    assert.ok(existsSync(file)); assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  } finally { r.done(); }
});

test('the typed confirmation is the folder name; the state key is the canonical path', () => {
  assert.equal(confirmWordFor('C:\\Users\\иван\\Проект Один\\'), 'Проект Один');
  assert.equal(confirmWordFor('C:/work/app'), 'app');
});

test('the loop: a pass ticks and refreshes only when something waits, never overlaps, never throws; the timer is injectable and unref-ed', async () => {
  const r = rig();
  try {
    let fire: () => void = () => {}, cleared = 0, refreshed = 0, ticks = 0, clock = NOW;
    const sched = { tick: () => { ticks++; } } as unknown as AutoScheduler;
    const stop = startAutoLoop(sched, { home: r.home, refresh: async () => { refreshed++; }, now: () => clock, setInt: ((f: () => void) => { fire = f; return { unref() {} }; }) as never, clearInt: (() => { cleared++; }) as never });
    fire(); await new Promise((x) => setImmediate(x));
    assert.equal(ticks, 1); assert.equal(refreshed, 0, 'nothing is waiting: no history sync');
    optIn(r); approve(r); assert.equal(hasPending(r.home), true);
    fire(); await new Promise((x) => setImmediate(x));
    assert.equal(refreshed, 1); assert.equal(ticks, 2);
    fire(); await new Promise((x) => setImmediate(x));
    assert.equal(refreshed, 1, 'refreshed at most every 10 minutes'); clock += 11 * 60_000;
    fire(); await new Promise((x) => setImmediate(x)); assert.equal(refreshed, 2);
    (sched as unknown as { tick: () => void }).tick = () => { throw new Error('boom'); };
    fire(); await new Promise((x) => setImmediate(x));
    stop(); assert.equal(cleared, 1);
  } finally { r.done(); }
});

test('panel data layer: a hostile answer is typed, unknown kinds and agents are dropped, text is plain', () => {
  assert.equal(M.autoModel(null), null); assert.equal(M.autoModel([]), null);
  const m = M.autoModel({ settings: { minLeftPct: 'x', loop: '<b>x</b>‮' }, projects: [
    { projectId: 3, slug: '<img onerror=alert(1)>​', enabled: 'true', confirmWord: 'ab', suggestions: [
      { kind: 'review-existing', agent: 'codex', expectedPct: 12, leftPct: 40, hoursToReset: 9, writes: 'main' }, { kind: 'rm-rf', agent: 'codex', expectedPct: 5, leftPct: 40, hoursToReset: 1 },
      { kind: 'missing-tests', agent: 'gemini', expectedPct: 5, leftPct: 40, hoursToReset: 1 }, { kind: 'missing-tests', agent: 'claude', expectedPct: Number.NaN, leftPct: 1, hoursToReset: 1 }],
      items: [{ id: '../x', kind: 'review-existing', agent: 'codex', status: 'approved' }, { id: 'au12345678', kind: 'review-existing', agent: 'codex', status: 'boom', runId: '../../etc' }] },
    { projectId: 'x' }, null] });
  assert.equal(m.settings.minLeftPct, 20); assert.ok(!/[‮]/.test(m.settings.loop));
  assert.equal(m.projects.length, 1); const p = m.projects[0];
  assert.equal(p.enabled, false, 'a string "true" does not mean enabled');
  assert.ok(!/[​]/.test(p.slug));
  assert.deepEqual(p.suggestions.map((s: { kind: string }) => s.kind), ['review-existing']); assert.equal(p.suggestions[0].writes, 'none', 'writes: main is shown as nothing special, never trusted');
  assert.deepEqual(p.items.map((i: { id: string; status: string; runId: string }) => [i.id, i.status, i.runId]), [['au12345678', 'cancelled', '']]);
  assert.equal(M.suggestionLine(p.suggestions[0]), 'До сброса Codex 9 ч, осталось 40 %: можно прогнать ревью старого кода');
  assert.equal(M.hoursText(0.4), '24 мин');
  assert.equal(M.confirmMatches(' Проект ', 'Проект'), true); assert.equal(M.confirmMatches('проект', 'Проект'), false); assert.equal(M.confirmMatches('', ''), false);
});

void mkdirSync;
