import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTEXT_CHAIN_MAX, contextBreakdown, contextChainDepth, contextLevel, handoffMode, hubOwnsFolder, rulesTokens } from './context.ts';
import { createSkillsEstimator } from './skills-estimate.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'context-model.js')).href) as { contextModel: (r: unknown) => any; gaugeText: (m: any) => string[]; tick: (m: any) => any; levelChip: (m: any) => [string, string] | null };
const G = await import(pathToFileURL(join(web, 'gauge-controller.js')).href) as { gaugeController: (o: any) => any; defaultTimers: Record<string, (...a: any[]) => any> };

const base = { firstCall: 20_000, rulesTokens: 2_000, skillsTokens: 18_000, lastContext: 64_000, window: 1_000_000, turns: 5 };
const answer = { runId: 'rab12', agent: 'claude', live: false, model: 'claude-sonnet-5-5', turns: 5, used: 64_000, firstCall: 20_000, window: 1_000_000, level: 'ok', handoff: 'restart', limit: 250_000, handoffAt: 250_000, amberAt: 200_000, rulesTokens: 2_000, skillsTokens: 18_000, estimated: true, cache: { ageSec: 100, ttlSec: 300 },
  breakdown: { system: 0, rules: 2_000, skills: 18_000, conversation: 44_000, used: 64_000, window: 1_000_000, turnsLeft: 16, handoffAt: 250_000 } };

// ── S3: the gauge promises only what the runner does ──────────────────────────────────────────────────────────────────────────────────────
test('handoffMode: ONE predicate for the runner and the gauge: restart only in a hub task folder with room and no autoContinue:false; a chat in the user\'s folder warns; limit 0 is off', () => {
  const ok = { limit: 250_000, branch: 'hub/t/claude', isolated: false, capped: false };
  assert.equal(handoffMode(ok), 'restart');
  assert.equal(handoffMode({ ...ok, branch: null }), 'warn', 'a chat in the user\'s own folder is only warned');
  assert.equal(handoffMode({ ...ok, isolated: true }), 'warn', 'a review-gate reviewer is never restarted');
  assert.equal(handoffMode({ ...ok, capped: true }), 'warn', 'three sessions in a row: stopped, no fourth');
  assert.equal(handoffMode({ ...ok, autoContinue: false }), 'warn', 'a cascade step is stopped with its card, not restarted');
  assert.equal(handoffMode({ ...ok, autoContinue: true }), 'restart');
  assert.equal(handoffMode({ ...ok, limit: 0 }), 'off'); assert.equal(handoffMode({ ...ok, limit: -1, branch: null }), 'off'); assert.equal(handoffMode({ ...ok, limit: Number.NaN }), 'off');
  assert.equal(hubOwnsFolder('hub/t/claude', false), true); assert.equal(hubOwnsFolder(null, false), false); assert.equal(hubOwnsFolder('b', true), false);
});

test('contextChainDepth counts sessions stopped for context back along handoffOf, at most CONTEXT_CHAIN_MAX, and survives a loop', () => {
  const rows: Record<string, { outcome: string | null; handoffOf: string | null }> = { a: { outcome: 'context', handoffOf: null }, b: { outcome: 'context', handoffOf: 'a' }, c: { outcome: 'done', handoffOf: 'b' }, l1: { outcome: 'context', handoffOf: 'l2' }, l2: { outcome: 'context', handoffOf: 'l1' } };
  const get = (id: string) => rows[id];
  assert.equal(contextChainDepth(get, undefined), 0); assert.equal(contextChainDepth(get, 'a'), 1); assert.equal(contextChainDepth(get, 'b'), 2);
  assert.equal(contextChainDepth(get, 'c'), 0, 'a run that ended normally breaks the chain'); assert.equal(contextChainDepth(get, 'nope'), 0);
  assert.equal(contextChainDepth(get, 'l1'), CONTEXT_CHAIN_MAX, 'a loop ends at the cap');
});

test('the limit in force drives the levels, turnsLeft and the tick: a lower limit turns red earlier, no limit has no turnsLeft', () => {
  assert.deepEqual([150_000, 160_000, 200_000].map((u) => contextLevel(u, 200_000)), ['ok', 'amber', 'red']);
  assert.equal(contextLevel(210_000, 0), 'amber', 'with no limit the default line still marks a large context'); assert.equal(contextLevel(260_000, 0), 'red');
  const b = contextBreakdown({ ...base, limit: 120_000 });
  assert.equal(b.handoffAt, 120_000); assert.equal(b.turnsLeft, Math.floor((120_000 - 64_000) / 11_000));
  assert.equal(contextBreakdown({ ...base, limit: 0 }).turnsLeft, null); assert.equal(contextBreakdown({ ...base, limit: 0 }).handoffAt, 0);
});

test('gauge words follow the handoff mode: restart promises the restart, warn says "start a new session yourself", off says nothing about handing over', () => {
  const at = (handoff: string, extra: object = {}, bd: object = {}) => M.contextModel({ ...answer, handoff, ...extra, breakdown: { ...answer.breakdown, ...bd } });
  const restart = at('restart');
  assert.equal(M.gaugeText(restart).at(-1), 'до передачи ≈ 16 шагов'); assert.equal(M.tick(restart).title, 'Здесь hub начнёт новую сессию из короткой записи');
  assert.equal(M.levelChip(at('restart', { level: 'red', used: 262_000 }))?.[0], 'Пора начать новую сессию');
  const warn = at('warn', { level: 'red', used: 262_000 });
  assert.equal(M.gaugeText(warn).some((t: string) => t.includes('до передачи')), false, 'no promise of a handover');
  assert.equal(M.gaugeText(warn).at(-1), 'до 250 тыс ≈ 16 шагов');
  assert.equal(M.levelChip(warn)?.[0], 'Контекст большой — начните новую сессию сами'); assert.equal(M.tick(warn).title, 'Здесь hub только предупредит: новую сессию нужно начать самому');
  const off = at('off', { level: 'red', used: 262_000, limit: 0 }, { turnsLeft: null });
  assert.equal(M.gaugeText(off).some((t: string) => /передач|до \d/.test(t)), false); assert.equal(M.tick(off), null, 'no limit, no tick');
  assert.equal(M.levelChip(off)?.[0], 'Контекст очень большой'); assert.equal(M.levelChip(at('off', { level: 'amber' }))?.[0], 'Контекст становится большим');
  assert.equal(M.contextModel({ ...answer, handoff: 'teleport' }).handoff, 'off', 'an unknown mode promises nothing');
  assert.equal(M.contextModel({ ...answer, limit: 120_000 }).limit, 120_000);
  assert.equal(M.tick(M.contextModel({ ...answer, limit: 120_000 })).left, 12, 'the tick sits at the EFFECTIVE limit: 120K of 1M');
  assert.equal(M.tick(M.contextModel({ ...answer, window: null })), null, 'no window, no bar, no tick');
  assert.equal(M.gaugeText(at('warn', { level: 'ok' }, { turnsLeft: 0 })).at(-1), 'до 250 тыс меньше шага');
});

test('rulesTokens counts the file the agent really loads: CLAUDE.md for Claude, AGENTS.md for Codex; a directory or a missing file counts 0; only sizes are read', () => {
  const d = mkdtempSync(join(tmpdir(), 'hub-rules-'));
  try {
    writeFileSync(join(d, 'AGENTS.md'), 'a'.repeat(4000)); writeFileSync(join(d, 'CLAUDE.md'), 'c'.repeat(800));
    assert.equal(rulesTokens(d, 'claude'), 200); assert.equal(rulesTokens(d, 'codex'), 1000);
    assert.equal(rulesTokens(join(d, 'nope'), 'claude'), 0);
    mkdirSync(join(d, 'sub')); mkdirSync(join(d, 'sub', 'CLAUDE.md'));
    assert.equal(rulesTokens(join(d, 'sub'), 'claude'), 0, 'a directory named CLAUDE.md counts 0');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── S2: the gauge's timers (DOM-free controller, fake clock) ──────────────────────────────────────────────────────────────────────────────
function clock() {
  let now = 0, id = 0; const t = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    timers: { setTimeout: (fn: () => void, ms: number) => { t.set(++id, { at: now + ms, fn }); return id; }, clearTimeout: (i: number) => { t.delete(i); }, setInterval: (fn: () => void, ms: number) => { t.set(++id, { at: now + ms, fn, every: ms }); return id; }, clearInterval: (i: number) => { t.delete(i); } },
    pending: () => t.size,
    async advance(ms: number) { const end = now + ms; for (;;) { const next = [...t.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; const [i, x] = next; if (x.every) x.at += x.every; else t.delete(i); x.fn(); await new Promise((r) => setImmediate(r)); } now = end; },
  };
}
const mk = (o: { connected?: () => boolean } = {}) => {
  const c = clock(), calls: string[] = [], draws: unknown[] = []; let live = false;
  const g = G.gaugeController({ fetchModel: async (id: string) => { calls.push(id); return { live, used: 1 }; }, render: (m: unknown) => draws.push(m), isConnected: o.connected ?? (() => true), timers: c.timers, liveMs: 4000, idleMs: 30_000, tickMs: 15_000, grace: 2 });
  return { c, calls, draws, g, setLive: (v: boolean) => { live = v; } };
};

test('gauge timers: polls every 4 s while live and every 30 s otherwise; stop() ends everything and a late show() cannot restart it', async () => {
  const h = mk(); h.setLive(true);
  h.g.show('r1'); await h.c.advance(0); assert.equal(h.calls.length, 1);
  await h.c.advance(8100); assert.equal(h.calls.length, 3, 'live: every 4 s');
  h.setLive(false); await h.c.advance(4000); const n = h.calls.length; await h.c.advance(29_000); assert.equal(h.calls.length, n, 'idle: not before 30 s'); await h.c.advance(2000); assert.equal(h.calls.length, n + 1);
  h.g.stop(); assert.equal(h.c.pending(), 0, 'no timer left');
  h.g.show('r2'); h.g.refresh(); await h.c.advance(200_000);
  assert.equal(h.calls.includes('r2'), false, 'a show() after stop() does nothing'); assert.equal(h.c.pending(), 0, 'and starts no timer');
});

test('gauge timers: a late answer after stop() is not drawn; a view that left the page stops polling; a view not yet mounted gets a short grace', async () => {
  let connected = false;
  const h = mk({ connected: () => connected });
  h.g.show('r1'); await h.c.advance(0); assert.ok(h.draws.at(-1), 'the first answer was drawn');
  await h.c.advance(31_000); assert.equal(h.calls.length, 2, 'not mounted yet: the grace allows a few polls'); connected = true;
  await h.c.advance(31_000); assert.equal(h.calls.length, 3); connected = false;
  await h.c.advance(200_000); assert.equal(h.calls.length, 3, 'it was on the page and left: it stops by itself'); assert.equal(h.c.pending(), 0);
  const k = mk({ connected: () => false }); k.g.show('r9'); await k.c.advance(500_000);
  assert.ok(k.calls.length <= 4, `never mounted: gives up after the grace (${k.calls.length} polls)`); assert.equal(k.c.pending(), 0);
  let release!: () => void;
  const slow = G.gaugeController({ fetchModel: () => new Promise((r) => { release = () => r({ live: true }); }), render: (m: unknown) => { if (m) throw new Error('drew after stop'); }, isConnected: () => true, timers: clock().timers });
  slow.show('r1'); slow.stop(); release(); await new Promise((r) => setImmediate(r));
});

// ── S1: the skills estimate is computed away from the request, once per change ────────────────────────────────────────────────────────────
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
test('skills estimate: a request never waits for the audit (it gets the last value or null at once); one refresh per root and fingerprint, not per poll; the oldest entry goes first', async () => {
  let runs = 0, fp = 'a'; const slow = 250;
  const e = createSkillsEstimator({ compute: async (root) => { runs++; await wait(slow); return { claude: root.length * 10, codex: 5 }; }, fingerprint: () => fp, max: 2, checkEveryMs: 0 });
  let worst = 0; const timed = <T,>(f: () => T): T => { const t = Date.now(); const r = f(); worst = Math.max(worst, Date.now() - t); return r; };
  assert.equal(timed(() => e.peek('/p1', 'claude')), null, 'first ask: not known yet, and it does not wait');
  assert.equal(timed(() => e.peek('/p1', 'claude')), null, 'still in flight: asking again starts nothing'); assert.equal(runs, 1);
  await wait(slow + 80);
  assert.equal(timed(() => e.peek('/p1', 'claude')), 30); assert.equal(timed(() => e.peek('/p1', 'codex')), 5); assert.equal(runs, 1, 'a poll with the same fingerprint does not recompute');
  fp = 'b';
  assert.equal(timed(() => e.peek('/p1', 'claude')), 30, 'the library changed: the OLD value is served while the new one is computed'); assert.equal(runs, 2);
  await wait(slow + 80); assert.equal(timed(() => e.peek('/p1', 'claude')), 30);
  timed(() => e.peek('/p2', 'claude')); await wait(slow + 80); timed(() => e.peek('/p3', 'claude')); await wait(slow + 80);
  assert.equal(e.size(), 2, 'at most max entries'); assert.equal(timed(() => e.peek('/p1', 'claude')), null, 'the oldest (/p1) was evicted, not the whole cache');
  assert.equal(timed(() => e.peek('/p3', 'claude')), 30);
  assert.ok(worst < 100, `no request blocked: worst ${worst} ms`);
});

test('skills estimate: a failing or never-finishing audit keeps the old value and does not pile up work; a hostile result is not trusted', async () => {
  let fail = false, calls = 0;
  const e = createSkillsEstimator({ compute: async () => { calls++; if (fail) throw new Error('boom'); return { claude: 7, codex: Number.NaN } as never; }, fingerprint: () => String(calls), checkEveryMs: 0, timeoutMs: 100 });
  e.peek('/p', 'claude'); await wait(30);
  assert.equal(e.peek('/p', 'claude'), 7); assert.equal(e.peek('/p', 'codex'), 0, 'a non-number is 0');
  fail = true; e.peek('/p', 'claude'); await wait(30); assert.equal(e.peek('/p', 'claude'), 7, 'a failed refresh keeps the old value');
  const hang = createSkillsEstimator({ compute: () => new Promise(() => {}), fingerprint: () => 'x', checkEveryMs: 0, timeoutMs: 60 });
  hang.peek('/q', 'claude'); await wait(150); assert.equal(hang.peek('/q', 'claude'), null);
});

test('the default timers are wrappers, not the bare globals: a browser throws "Illegal invocation" when window.setTimeout is called as a method of another object', async () => {
  for (const [name, fn] of Object.entries(G.defaultTimers)) assert.equal('prototype' in fn, false, `${name} must be an arrow wrapper`);
  const strict = (real: (...a: any[]) => any) => function (this: unknown, ...a: any[]) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return real(...a); };
  const bare = { setTimeout: strict(setTimeout), clearTimeout: strict(clearTimeout), setInterval: strict(setInterval), clearInterval: strict(clearInterval) };
  assert.throws(() => bare.setTimeout(() => {}, 1), /Illegal invocation/, 'the strict stand-in does what a browser does to a bare global');
  const wrapped = { setTimeout: (f: () => void, ms: number) => bare.setTimeout.call(undefined, f, ms), clearTimeout: (i: never) => bare.clearTimeout.call(undefined, i), setInterval: (f: () => void, ms: number) => bare.setInterval.call(undefined, f, ms), clearInterval: (i: never) => bare.clearInterval.call(undefined, i) };
  const g = G.gaugeController({ fetchModel: async () => ({ live: false }), render: () => {}, isConnected: () => true, timers: wrapped, idleMs: 1_000_000, tickMs: 1_000_000 });
  g.show('r1'); await new Promise((r) => setImmediate(r)); g.stop();
});
