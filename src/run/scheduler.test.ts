import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { authStatusIn } from '../adapters/auth.ts';
import { APPROVAL_TTL_MS, MAX_STARTS_PER_DAY, MIN_LEFT_PCT, SAFETY_MARGIN_PCT, billingOk, projectSettingsProblem, startReqFor, suggestBeforeReset, validJob, type QueuedJob } from './scheduler.ts';
import { startAutoLoop, hasPending } from './autouse-wire.ts';
import { acquireLock, holdsLock, lockStatus, type LockDeps } from './autouse-lock.ts';
import { AutoScheduler, confirmWordFor, loadAuto, loadAutoRaw, setEnabled, approveItem, cancelItem, saveAuto, projectKeyOf, type AutoDeps } from './autouse.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'autouse-model.js')).href) as { autoModel: (r: unknown) => any; suggestionLine: (s: any) => string; hoursText: (h: number) => string; confirmMatches: (a: unknown, b: unknown) => boolean };
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const sec = NOW / 1000;
const job = (over: Partial<QueuedJob> = {}): QueuedJob => ({ id: 'j1', kind: 'review-existing', projectId: 1, agent: 'codex', expectedPct: 12, writes: 'none', ...over });
const lim = (used: number | null, resetsInH: number | null, over: Record<string, unknown> = {}) => ({ usedPercent: used, reached: false, windowMinutes: 10080, resetsAt: resetsInH == null ? null : sec + resetsInH * 3600, ...over });

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

function rig(opts: { now?: () => number; limits?: Record<string, unknown>; billing?: (a: string, root?: string) => { ok: boolean; why?: string }; breaker?: (root: string) => string | null; live?: Set<string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hub-auto-'));
  const root = mkdtempSync(join(tmpdir(), 'hub-auto-root-'));
  const calls = { start: [] as { job: QueuedJob; root: string }[], stop: [] as string[] };
  let clock = NOW;
  const live = opts.live ?? new Set<string>();
  const deps: AutoDeps = {
    home, now: opts.now ?? (() => clock),
    limits: () => (opts.limits ?? { codex: { ...lim(40, 6), ts: new Date(clock).toISOString() } }) as never,
    billing: opts.billing ?? (() => ({ ok: true })), projectCheck: () => null,
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
    const st = loadAutoRaw(r.home);
    assert.deepEqual(Object.values(st.projects).filter((p) => p.enabled), [], 'no row with a loose "enabled" counts');
    assert.equal(st.items.length, 0); assert.deepEqual(st.starts, [5]);
    writeFileSync(file, 'x'.repeat(2_000_000));
    assert.deepEqual(loadAutoRaw(r.home).items, []);
    writeFileSync(file, '{not json');
    assert.deepEqual(loadAutoRaw(r.home).projects, {});
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

// ---------- review fix 3: the Claude settings of the project folder ----------

const settingsDir = (files: Record<string, unknown | string>): string => {
  const d = mkdtempSync(join(tmpdir(), 'hub-set-'));
  mkdirSync(join(d, '.claude'), { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(join(d, '.claude', f), typeof v === 'string' ? v : JSON.stringify(v));
  return d;
};

test('a scheduler-started Claude run reads only the USER settings (--setting-sources user); a Codex run gets no such flag', () => {
  const c = startReqFor(job({ agent: 'claude' }), '/p'), x = startReqFor(job({ agent: 'codex' }), '/p');
  assert.deepEqual(c.extraArgs, ['--setting-sources', 'user']);
  assert.equal(x.extraArgs, undefined);
  const t = startReqFor(job({ agent: 'claude', kind: 'missing-tests', writes: 'branch' }), '/p');
  assert.deepEqual(t.extraArgs, ['--setting-sources', 'user']);
});

test('projectSettingsProblem: env, apiKeyHelper, hooks and an allow list in the project .claude settings are refused, with the reason; a plain folder is fine', () => {
  const ok = (files: Record<string, unknown>): string | null => { const d = settingsDir(files); try { return projectSettingsProblem(d); } finally { rmSync(d, { recursive: true, force: true }); } };
  assert.equal(ok({}), null);
  assert.equal(ok({ 'settings.json': { model: 'opus', outputStyle: 'x', cleanupPeriodDays: 30, includeCoAuthoredBy: false, spinnerTipsEnabled: false, permissions: { deny: ['Bash(rm:*)'], ask: ['Edit'] } } }), null, 'the small known-safe set, and a deny / ask list, are accepted');
  // S4: an ALLOWLIST: every key that is not known to be safe is refused, and the key is named
  for (const [key, value] of Object.entries({ env: { ANTHROPIC_BASE_URL: 'http://x' }, apiKeyHelper: 'get-key.sh', hooks: { PreToolUse: [] }, enabledPlugins: { 'a@b': true }, statusLine: { type: 'command', command: 'x' },
    awsAuthRefresh: 'x', awsCredentialExport: 'x', otelHeadersHelper: 'x', enableAllProjectMcpServers: true, enabledMcpjsonServers: ['x'], forceLoginMethod: 'console', anyFutureKey: 1, env2: {} })) {
    assert.match(ok({ 'settings.json': { [key]: value } }) ?? '', new RegExp(`\\b${key}\\b`), key);
    assert.match(ok({ 'settings.local.json': { [key]: value } }) ?? '', new RegExp(`settings\\.local\\.json[\\s\\S]*${key}`), `${key} in the local file`);
  }
  assert.match(ok({ 'settings.json': { env: {} } }) ?? '', /env/, 'even an empty env: the key itself is not in the safe set');
  for (const perm of [{ allow: ['Bash(*)'] }, { defaultMode: 'bypassPermissions' }, { additionalDirectories: ['C:/'] }, { deny: ['x'], other: 1 }, { deny: 'x' }, { ask: [1] }]) assert.match(ok({ 'settings.json': { permissions: perm } }) ?? '', /permissions\.\w+/, JSON.stringify(perm));
  assert.match(ok({ 'settings.json': { permissions: [] } }) ?? '', /permissions/);
  assert.match(ok({ 'settings.json': { ['x'.repeat(200)]: 1 } }) ?? '', /^.{0,160}$/, 'a long key name is clipped in the message');
  assert.match(ok({ 'settings.json': { ['bad\u202e\nkey']: 1 } }) ?? '', /^[^\u202e\n]*$/, 'control and bidi characters of a key never reach the message');
  assert.match(ok({ 'settings.json': '{bad json' }) ?? '', /не удалось прочитать/);
  assert.match(ok({ 'settings.json': JSON.stringify({ pad: 'x'.repeat(300_000) }) }) ?? '', /не удалось прочитать/);
  assert.match(ok({ 'settings.json': '[]' }) ?? '', /не удалось прочитать|не объект/);
  assert.equal(projectSettingsProblem(join(tmpdir(), 'hub-no-such-folder-xyz')), null, 'no folder, no settings');
  // a project .mcp.json adds MCP servers that run commands
  const d = settingsDir({}); writeFileSync(join(d, '.mcp.json'), '{"mcpServers":{}}');
  try { assert.match(projectSettingsProblem(d) ?? '', /\.mcp\.json/); } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S4: for a job that works in a worktree (cut from HEAD) the COMMITTED settings are checked, not the working copy', () => {
  const d = mkdtempSync(join(tmpdir(), 'hub-head-'));
  try {
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://evil' } })); g('add', '-A'); g('commit', '-qm', 'one');
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));          // the working copy is clean, the commit is not
    assert.equal(projectSettingsProblem(d), null, 'the working copy looks fine');
    assert.match(projectSettingsProblem(d, { source: 'head' }) ?? '', /env/, 'but the worktree would be cut from the commit that has env');
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' })); g('add', '-A'); g('commit', '-qm', 'two');
    assert.equal(projectSettingsProblem(d, { source: 'head' }), null);
    writeFileSync(join(d, '.mcp.json'), '{}'); g('add', '-A'); g('commit', '-qm', 'three');
    assert.match(projectSettingsProblem(d, { source: 'head' }) ?? '', /\.mcp\.json/);
    assert.equal(projectSettingsProblem(join(d, 'nothing'), { source: 'head' }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S4: the subscription check of a Claude agent is spawned with --setting-sources user and the SAME environment the run gets, from the project folder', () => {
  const calls: { cmd: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  const runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => { calls.push({ cmd, args, opts: opts ?? {} }); return { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }; };
  const env = { PATH: 'p', ANTHROPIC_API_KEY: '' };
  const a = authStatusIn('claude', { installed: true, path: 'claude' } as never, '/proj', runner as never, env);
  assert.deepEqual(a, { loggedIn: true, how: 'claude.ai' });
  assert.deepEqual(calls[0]!.args, ['auth', 'status', '--setting-sources', 'user']);
  assert.equal(calls[0]!.opts.cwd, '/proj'); assert.equal(calls[0]!.opts.env, env);
  authStatusIn('codex', { installed: true, path: 'codex' } as never, '/proj', runner as never, env);
  assert.deepEqual(calls[1]!.args, ['login', 'status'], 'no Claude flag for Codex');
});

test('tick: a project whose Claude settings could change billing or run commands is not started; the check runs for the folder the run will use; billing is asked with that folder', () => {
  const r = rig();
  try {
    optIn(r); approve(r, { agent: 'claude' });
    r.deps.limits = () => ({ claude: { ...lim(40, 6), ts: new Date(NOW).toISOString() } }) as never;
    const asked: unknown[] = [];
    r.deps.billing = (a, root) => { asked.push([a, root]); return { ok: true }; };
    r.deps.projectCheck = (root, agent) => (agent === 'claude' ? `в ${root} есть .claude/settings.json с env` : null);
    const rep = new AutoScheduler(r.deps).tick();
    assert.equal(r.calls.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'project-settings' && /env/.test(x.detail ?? '')));
    assert.equal(loadAuto(r.home).items[0]!.status, 'approved', 'still waiting: the user can fix the folder');
    r.deps.projectCheck = () => null;
    new AutoScheduler(r.deps).tick();
    assert.equal(r.calls.start.length, 1);
    assert.deepEqual(asked.at(-1), ['claude', r.root], 'the subscription check is made for the folder of the run');
  } finally { r.done(); }
});

// ---------- review fix 2: one scheduler per hub home ----------

function lockRig() {
  const r = rig();
  let clock = NOW;
  const alive = new Set<number>([1111, 2222]);
  const lockOf = (pid: number): LockDeps => ({ home: r.home, pid, now: () => clock, alive: (p) => alive.has(p) });
  const sched = (pid: number, calls: { start: QueuedJob[]; stop: string[] }, live: Set<string>) => new AutoScheduler({
    ...r.deps, now: () => clock, pid, alive: (p: number) => alive.has(p), lock: { hold: () => holdsLock(lockOf(pid)) },
    limits: () => ({ codex: { ...lim(40, 6), resetsAt: clock / 1000 + 6 * 3600, ts: new Date(clock).toISOString() } }) as never,
    start: (j) => { calls.start.push(j); const id = `r${pid}x${calls.start.length}`; live.add(id); return { runId: id }; }, stop: (id) => { calls.stop.push(id); live.delete(id); },
    runState: (id) => ({ live: live.has(id), outcome: live.has(id) ? null : 'review' }),
  });
  return { ...r, lockOf, alive, sched, advance: (ms: number) => { clock += ms; } };
}

test('B1: the lock is created exclusively; a LIVE owner is never replaced, however old its heartbeat; a dead owner is; an unreadable lock is', () => {
  const r = lockRig();
  try {
    assert.deepEqual(acquireLock(r.lockOf(1111)), { ok: true });
    const second = acquireLock(r.lockOf(2222));
    assert.equal(second.ok, false); assert.equal((second as { owner: number | null }).owner, 1111);
    assert.equal(holdsLock(r.lockOf(1111)), true); assert.equal(holdsLock(r.lockOf(2222)), false);
    r.advance(4 * 60_000);
    assert.equal(holdsLock(r.lockOf(2222)), false, 'four minutes without a heartbeat is not a reason: the owner process is alive');
    r.advance(40 * 60_000);
    assert.equal(holdsLock(r.lockOf(2222)), false, 'not even after 40 minutes: fail closed');
    const st = lockStatus(r.lockOf(2222));
    assert.deepEqual([st.state, st.owner, st.silent], ['other', 1111, true], 'the other process is reported, and that it has been silent for a long time');
    assert.equal(lockStatus(r.lockOf(1111)).state, 'own');
    r.alive.delete(1111);
    assert.equal(holdsLock(r.lockOf(2222)), true, 'the owner is gone: its lock is taken over');
    assert.equal(holdsLock(r.lockOf(1111)), false, 'and the old owner no longer holds it');
    writeFileSync(join(r.home, 'autouse.lock'), '{garbage');
    assert.equal(lockStatus(r.lockOf(2222)).state, 'free');
    assert.equal(holdsLock(r.lockOf(1111)), true, 'an unreadable lock is stale');
  } finally { r.done(); }
});

test('B1: a pid reused by an unrelated process: the start time the owner recorded does not match the live one, so the lock is stale; without a probe a live pid is never replaced', () => {
  const r = lockRig();
  try {
    const own = (pid: number, startedMs: number, probe?: (p: number) => number | null): LockDeps => ({ ...r.lockOf(pid), startedMs, ...(probe ? { probe } : {}) });
    assert.deepEqual(acquireLock(own(1111, 5_000_000)), { ok: true });
    assert.equal(holdsLock(own(2222, 6_000_000)), false, 'no probe: a live pid stays the owner');
    assert.equal(holdsLock(own(2222, 6_000_000, () => 5_000_500)), false, 'the live process started when the owner said: it is the owner');
    assert.equal(holdsLock(own(2222, 6_000_000, () => null)), false, 'start time unknown: it is the owner');
    assert.equal(holdsLock(own(2222, 6_000_000, () => 9_999_000)), true, 'the live process started later than the owner: the pid was reused, the lock is stale');
  } finally { r.done(); }
});

test('B1: two takeovers of one stale lock: exactly one wins, and the loser puts the lock it moved aside back', () => {
  const r = lockRig();
  try {
    assert.deepEqual(acquireLock(r.lockOf(1111)), { ok: true });
    r.alive.delete(1111);
    let aWon: boolean | undefined;
    // B has read the stale lock and is about to move it aside; A completes its whole takeover first
    const b: LockDeps = { ...r.lockOf(2222), beforeRename: () => { aWon = acquireLock(r.lockOf(3333)).ok; } };
    r.alive.add(3333);
    const bGot = acquireLock(b);
    assert.equal(aWon, true); assert.equal(bGot.ok, false, 'B moved A\'s fresh lock, saw it was not the one it had checked, and gave it back');
    assert.equal(lockStatus(r.lockOf(3333)).state, 'own');
    assert.equal(holdsLock(r.lockOf(2222)), false); assert.equal(holdsLock(r.lockOf(3333)), true);
  } finally { r.done(); }
});

test('B1: the heartbeat has its own timer; stop clears it and releases the lock; a long history sync cannot starve it', async () => {
  const r = lockRig();
  try {
    let fire: (() => void)[] = [], cleared = 0, clock = NOW;
    const sched = { tick: () => {} } as unknown as AutoScheduler;
    let release!: () => void;
    const lock: LockDeps = { ...r.lockOf(1111), now: () => clock };
    const stop = startAutoLoop(sched, { home: r.home, lock, refresh: () => new Promise<void>((res) => { release = res; }), now: () => clock, setInt: ((f: () => void) => { fire.push(f); return { unref() {} }; }) as never, clearInt: (() => { cleared++; }) as never });
    assert.equal(fire.length, 2, 'one timer for the passes, one for the heartbeat');
    assert.deepEqual(acquireLock(lock), { ok: true });
    optIn(r); approve(r);                       // something is waiting: the next pass starts a history sync that does not finish
    fire[0]!(); await new Promise((x) => setImmediate(x));
    const at0 = JSON.parse(readFileSync(join(r.home, 'autouse.lock'), 'utf8')).at;
    clock += 10 * 60_000; fire[1]!();            // the heartbeat timer fires while the sync is still running
    assert.equal(JSON.parse(readFileSync(join(r.home, 'autouse.lock'), 'utf8')).at, clock);
    assert.ok(JSON.parse(readFileSync(join(r.home, 'autouse.lock'), 'utf8')).at > at0);
    release(); await new Promise((x) => setImmediate(x));
    stop();
    assert.equal(cleared, 2); assert.equal(existsSync(join(r.home, 'autouse.lock')), false, 'a clean stop releases the lock');
    fire = [];
  } finally { r.done(); }
});

test('B1: the observed case: A hosts a live run, B ticks 4 minutes later: B starts NOTHING and ra1 stays started', () => {
  const r = lockRig();
  try {
    optIn(r); approve(r); approve(r, { id: 'second' });
    const a = { start: [] as QueuedJob[], stop: [] as string[] }, b = { start: [] as QueuedJob[], stop: [] as string[] }, liveA = new Set<string>(), liveB = new Set<string>();
    const A = r.sched(1111, a, liveA), B = r.sched(2222, b, liveB);
    A.tick();
    const runId = loadAuto(r.home).items.find((i) => i.status === 'started')!.runId;
    r.advance(4 * 60_000);
    const rep = B.tick();
    assert.equal(b.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'not-owner'));
    const it = loadAuto(r.home).items.find((i) => i.runId === runId)!;
    assert.equal(it.status, 'started', 'the run of A is still started');
    assert.equal(loadAuto(r.home).items.filter((i) => i.status === 'started').length, 1);
  } finally { r.done(); }
});

test('B1(c): even holding the lock, a started item whose owner process is alive and is not this one is never marked finished or replaced', () => {
  const r = lockRig();
  try {
    optIn(r); approve(r); approve(r, { id: 'second' });
    const a = { start: [] as QueuedJob[], stop: [] as string[] }, b = { start: [] as QueuedJob[], stop: [] as string[] }, liveA = new Set<string>(), liveB = new Set<string>();
    const A = r.sched(1111, a, liveA);
    A.tick();
    // the lock file is somehow B's (a lost race, an old lock) while A's run is alive
    const B = new AutoScheduler({ ...r.deps, pid: 2222, now: () => NOW, lock: { hold: () => true }, alive: (p) => r.alive.has(p),
      limits: () => ({ codex: { ...lim(40, 6), ts: new Date(NOW).toISOString() } }) as never, start: (j) => { b.start.push(j); return { runId: 'rb1' }; }, stop: (id) => { b.stop.push(id); }, runState: () => ({ live: false, outcome: null }) });
    const rep = B.tick();
    assert.equal(b.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'busy'));
    assert.equal(loadAuto(r.home).items.find((i) => i.ownerPid === 1111)!.status, 'started');
    r.alive.delete(1111);
    B.tick();
    assert.equal(loadAuto(r.home).items.find((i) => i.ownerPid === 1111)!.status, 'finished', 'its owner is gone: now it is an orphan');
    assert.equal(b.start.length, 1);
  } finally { r.done(); }
});

// ---------- review notes: n1 (switching off or cancelling stops a live auto run), n7 (the opt-in follows the repo, not the folder) ----------

test('n1: switching a project off stops its LIVE auto run through the stop function, and cancelling a started item stops it too', () => {
  const r = rig();
  try {
    optIn(r); approve(r); approve(r, { id: 'second' });
    const s = new AutoScheduler(r.deps); s.tick();
    assert.equal(loadAuto(r.home).items.find((i) => i.status === 'started')!.runId, 'rauto1');
    const stopped: string[] = [];
    setEnabled(r.home, r.root, false, NOW, { stop: (id) => stopped.push(id) });
    assert.deepEqual(stopped, ['rauto1']);
    const items = loadAuto(r.home).items;
    assert.equal(items.find((i) => i.id === 'j1')!.status, 'stopped'); assert.match(items.find((i) => i.id === 'j1')!.note ?? '', /выключили/);
    assert.equal(items.find((i) => i.id === 'second')!.status, 'cancelled');
    optIn(r); approve(r, { id: 'third' });
    new AutoScheduler(r.deps).tick();
    const started = loadAuto(r.home).items.find((i) => i.status === 'started')!;
    assert.equal(cancelItem(r.home, started.id, NOW, (id) => stopped.push(id)), true);
    assert.equal(stopped.at(-1), started.runId); assert.equal(loadAuto(r.home).items.find((i) => i.id === started.id)!.status, 'stopped');
    assert.equal(cancelItem(r.home, started.id, NOW, (id) => stopped.push(id)), false, 'a finished item cannot be cancelled again');
  } finally { r.done(); }
});

test('n7: the opt-in belongs to the repository, not the folder: a different repo at the same path drops it and cancels the approvals', () => {
  const r = rig();
  try {
    let repo: string | null = 'first-commit-A';
    r.deps.repoId = () => repo;
    setEnabled(r.home, r.root, true, NOW, { repoId: 'first-commit-A' });
    approveItem(r.home, job(), r.root, NOW, { repoId: 'first-commit-A' });
    assert.throws(() => approveItem(r.home, job({ id: 'x' }), r.root, NOW, { repoId: 'first-commit-B' }), /другой репозиторий|repository/);
    repo = 'first-commit-B';
    const rep = new AutoScheduler(r.deps).tick();
    assert.equal(r.calls.start.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'repo-changed'));
    const st = loadAuto(r.home);
    assert.deepEqual(Object.keys(st.projects), [], 'the opt-in is gone'); assert.equal(st.items[0]!.status, 'cancelled');
    repo = null;
    setEnabled(r.home, r.root, true, NOW, { repoId: null });
    approveItem(r.home, job({ id: 'again' }), r.root, NOW, { repoId: null });
    new AutoScheduler(r.deps).tick();
    assert.equal(r.calls.start.length, 1, 'switching it on again for the new repo works');
  } finally { r.done(); }
});

void mkdirSync;
