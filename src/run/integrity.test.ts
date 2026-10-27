import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Review fix 4: the hub remembers a hash of what it last wrote into its own settings files; a change made by anything else is tamper, not configuration.
const base = mkdtempSync(join(tmpdir(), 'hub-integ-'));
process.env['USERPROFILE'] = base; process.env['HOME'] = base; process.env['AGENT_HUB_HOME'] = join(base, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const HOME = process.env['AGENT_HUB_HOME'] as string;
const { AutoScheduler, loadAuto, loadAutoRaw, saveAuto, setEnabled, approveItem } = await import('./autouse.ts');
const { tamperList, resetTamper, seal, fileState, sealFile, hashFile } = await import('./integrity.ts');
const { spawnSync } = await import('node:child_process');
const { renameSync } = await import('node:fs');
const { userCapsRaw, ackTrip, loadAcks, makeGuard, effectiveCaps } = await import('./breaker.ts');
const { saveUserConfig, loadUserConfig } = await import('../core/registry.ts');
const { sealGuardrailsConfig } = await import('./integrity.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('./runner.ts');
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const job = { id: 'j1', kind: 'review-existing' as const, projectId: 1, agent: 'codex' as const, expectedPct: 5, writes: 'none' as const };
const fresh = (): { home: string; root: string } => ({ home: mkdtempSync(join(base, 'h-')), root: mkdtempSync(join(base, 'p-')) });
const deps = (home: string, root: string, started: unknown[]) => ({
  home, now: () => NOW, limits: () => ({ codex: { usedPercent: 40, reached: false, resetsAt: NOW / 1000 + 6 * 3600, ts: new Date(NOW).toISOString(), windowMinutes: 10080 } }) as never,
  billing: () => ({ ok: true }), breaker: () => null, projectRoot: () => root, start: (j: unknown) => { started.push(j); return { runId: 'rauto1' }; }, stop: () => {}, runState: () => ({ live: true, outcome: null }),
});

test('the hub\'s own writes never look like tamper', () => {
  const { home, root } = fresh();
  setEnabled(home, root, true, NOW); approveItem(home, job, root, NOW);
  const started: unknown[] = [];
  const s = new AutoScheduler(deps(home, root, started));
  s.tick(); s.tick();
  assert.equal(started.length, 1); assert.deepEqual(tamperList([home]), []);
  assert.equal(loadAuto(home).items[0]!.status, 'started');
});

test('autouse.json changed by something other than the hub: everything reads as OFF, the scheduler refuses, the change is recorded once and shown; a reset starts from nothing', () => {
  const { home, root } = fresh();
  setEnabled(home, root, true, NOW); approveItem(home, job, root, NOW);
  const good = readFileSync(join(home, 'autouse.json'), 'utf8');
  const doc = JSON.parse(good);
  doc.items[0].expectedPct = 1; doc.items[0].status = 'approved'; doc.items.push({ ...doc.items[0], id: 'evil', kind: 'missing-tests', writes: 'branch' });
  writeFileSync(join(home, 'autouse.json'), JSON.stringify(doc));          // not through saveAuto: no new seal
  const st = loadAuto(home);
  assert.deepEqual([st.items.length, Object.keys(st.projects).length], [0, 0], 'a file the hub did not write is not read');
  const started: unknown[] = [];
  const rep = new AutoScheduler(deps(home, root, started)).tick();
  assert.equal(started.length, 0); assert.ok(rep.skipped.some((x) => x.why === 'tamper'));
  loadAuto(home); loadAuto(home);
  const t = tamperList([home]);
  assert.deepEqual(t.map((x) => x.file), ['autouse.json']);
  assert.equal(readFileSync(join(home, 'autouse-audit.jsonl'), 'utf8').split('\n').filter((l) => /tamper/.test(l)).length, 1, 'the audit log has one line, not one per read');
  resetTamper([home], HOME);
  assert.deepEqual(tamperList([home]), []); assert.deepEqual(loadAuto(home).items, []);
  setEnabled(home, root, true, NOW); approveItem(home, { ...job, id: 'j2' }, root, NOW);
  new AutoScheduler(deps(home, root, started)).tick();
  assert.equal(started.length, 1, 'after the user looked and reset, a fresh switch-on works');
});

test('an existing autouse.json that the hub never sealed counts as changed (fail closed), an absent one is fine', () => {
  const { home, root } = fresh();
  assert.deepEqual(loadAuto(home).items, []); assert.deepEqual(tamperList([home]), []);
  writeFileSync(join(home, 'autouse.json'), JSON.stringify({ version: 1, projects: {}, items: [], starts: [] }));
  loadAuto(home);
  assert.equal(tamperList([home]).length, 1);
  void root;
});

test('guardrails config edited by hand or by an agent (not through the route): ignored, the protection stays ON with the defaults, the change is recorded', () => {
  const cfg = loadUserConfig();
  saveUserConfig({ ...cfg, guardrails: { enabled: false, runWeighted: 1 } });           // written without sealing: not the hub's route
  assert.equal(userCapsRaw(), undefined, 'ignored');
  assert.equal(effectiveCaps(userCapsRaw()).caps.enabled, true);
  assert.ok(tamperList([HOME]).some((x) => x.file === 'config.json guardrails'));
  // the protection really is on: three identical failures still block a start in a RunManager built with the default guard
  const db = openDb(':memory:'), root = mkdtempSync(join(base, 'p-')), now = Date.now();
  const pid = (db.prepare("INSERT INTO project (key, root, slug) VALUES (?,?,?) RETURNING id").get(root.replace(/\\/g, '/').toLowerCase(), root, 'p') as { id: number }).id;
  for (let i = 0; i < 3; i++) db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, error) VALUES (?,?,?,?,?,?,?)').run(`rf${i}`, pid, 'claude', new Date(now - (i + 2) * 60_000).toISOString(), new Date(now - (i + 1) * 60_000).toISOString(), 'failed', 'same boom');
  const rm = new RunManager(db, { summarize: false, home: mkdtempSync(join(base, 'h-')) });
  assert.throws(() => rm.start({ agent: 'claude', prompt: 'x', projectRoot: root }), /Защита от лишних запусков/);
  // the route's own write is sealed and honoured
  const next = { runWeighted: 10 };
  saveUserConfig({ ...loadUserConfig(), guardrails: next }); sealGuardrailsConfig(HOME);
  assert.deepEqual(userCapsRaw(), next);
  saveUserConfig({ ...loadUserConfig(), guardrails: { ...next, enabled: false } });      // an edit after the seal
  assert.equal(userCapsRaw(), undefined);
  resetTamper([HOME], HOME);
  assert.equal(loadUserConfig().guardrails, undefined, 'a reset returns to the defaults');
  assert.equal(userCapsRaw(), undefined); assert.deepEqual(tamperList([HOME]), []);
});

test('acknowledgements edited behind the hub\'s back are ignored; the hub\'s own acknowledgement is honoured', () => {
  const { home } = fresh();
  assert.equal(ackTrip(home, 'same-failure:7', NOW), true);
  assert.deepEqual(loadAcks(home), { 'same-failure:7': NOW });
  writeFileSync(join(home, 'guardrails.json'), JSON.stringify({ acks: { 'same-failure:7': NOW + 9e9, 'same-failure:8': NOW + 9e9 } }));
  assert.deepEqual(loadAcks(home), {}, 'forged acknowledgements clear nothing');
  assert.ok(tamperList([home]).some((x) => x.file === 'guardrails.json'));
  void makeGuard; void existsSync;
});

// ---------- second review round ----------

test('S1: a tampered state file does not hide a live run: the loop stops it through the normal stop path (from its own memory and from the run table)', () => {
  const { home, root } = fresh();
  setEnabled(home, root, true, NOW); approveItem(home, job, root, NOW);
  const started: unknown[] = [], stopped: string[] = [], live = new Set<string>(['rtable9']);
  const d = { ...deps(home, root, started), stop: (id: string) => { stopped.push(id); }, runState: (id: string) => ({ live: id === 'rauto1' || live.has(id), outcome: null }), liveAutoRuns: () => ['rtable9'] };
  const s = new AutoScheduler(d);
  s.tick();
  assert.equal(started.length, 1);
  const doc = JSON.parse(readFileSync(join(home, 'autouse.json'), 'utf8')); doc.items[0].note = 'edited';
  writeFileSync(join(home, 'autouse.json'), JSON.stringify(doc));          // not through the hub
  const rep = s.tick();
  assert.deepEqual(stopped.sort(), ['rauto1', 'rtable9']);
  assert.ok(rep.skipped.some((x) => x.why === 'tamper')); assert.equal(rep.stopped.length, 2);
  stopped.length = 0; s.tick();
  assert.deepEqual(stopped, ['rtable9'], 'the run table still shows one that is live: it keeps being stopped, and nothing is started');
  assert.equal(started.length, 1);
});

test('S1: three processes sealing different keys of one folder at once lose no seal (the seal file is written under a lock)', () => {
  const dir = mkdtempSync(join(base, 'seal-')), worker = join(dirname(fileURLToPath(import.meta.url)), 'integrity-worker.mjs');
  const procs = ['a', 'b', 'c'].map((p) => import('node:child_process').then((m) => new Promise<number | null>((res) => { const c = m.spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, dir, p, '70'], { stdio: 'ignore' }); c.on('exit', res); })));
  return Promise.all(procs).then((codes) => {
    assert.deepEqual(codes, [0, 0, 0]);
    const seals = JSON.parse(readFileSync(join(dir, 'integrity.json'), 'utf8')).seals as Record<string, string>;
    assert.equal(Object.keys(seals).length, 210, 'every one of the 210 seals is there');
    for (const p of ['a', 'b', 'c']) for (let i = 0; i < 70; i++) assert.equal(seals[`${p}${i}`], `hash-${p}${i}`);
    assert.equal(existsSync(join(dir, 'integrity.json.lock')), false, 'the lock file is gone');
    void spawnSync;
  });
});

test('S1: a reader that catches the short gap between sealing and renaming does not flag tamper: it retries first', () => {
  const dir = mkdtempSync(join(base, 'gap-'));
  writeFileSync(join(dir, 'x.json'), 'old'); sealFile(dir, 'x.json');
  writeFileSync(join(dir, 'x.json.tmp'), 'new');
  seal(dir, 'x.json', hashFile(join(dir, 'x.json.tmp')));                  // sealed first ...
  let slept = 0;
  const state = fileState(dir, 'x.json', { sleep: () => { slept++; renameSync(join(dir, 'x.json.tmp'), join(dir, 'x.json')); } });   // ... the rename happens while the reader waits
  assert.equal(state, 'ok'); assert.equal(slept, 1);
  writeFileSync(join(dir, 'x.json'), 'forged');
  assert.equal(fileState(dir, 'x.json', { sleep: () => {} }), 'changed', 'a real change still shows after the retries');
});

test('N1: once the hub sealed a guardrails config, a MISSING value is tamper (it would silently loosen the caps)', () => {
  const cfg = loadUserConfig();
  saveUserConfig({ ...cfg, guardrails: { runWeighted: 10 } }); sealGuardrailsConfig(HOME);
  assert.deepEqual(userCapsRaw(), { runWeighted: 10 });
  const { guardrails: _g, ...rest } = loadUserConfig(); saveUserConfig(rest);                // deleted behind the hub's back
  assert.equal(userCapsRaw(), undefined);
  assert.ok(tamperList([HOME]).some((x) => x.file === 'config.json guardrails'), 'the deletion is reported');
  resetTamper([HOME], HOME);
  assert.deepEqual(tamperList([HOME]), []); assert.equal(userCapsRaw(), undefined);
});

test('S5: a reset touches only the files that were flagged: flagged autouse leaves the caps and the acknowledgements alone, and vice versa', () => {
  const { home, root } = fresh();
  saveUserConfig({ ...loadUserConfig(), guardrails: { runWeighted: 10 } }); sealGuardrailsConfig(HOME);
  assert.equal(ackTrip(home, 'same-failure:7', NOW), true);
  setEnabled(home, root, true, NOW);
  writeFileSync(join(home, 'autouse.json'), JSON.stringify({ version: 1, projects: {}, items: [], starts: [] }));
  loadAuto(home);
  assert.deepEqual(tamperList([home]).map((t) => t.file), ['autouse.json']);
  resetTamper([home], HOME);
  assert.deepEqual(userCapsRaw(), { runWeighted: 10 }, 'the tightened caps of the user survive');
  assert.deepEqual(loadAcks(home), { 'same-failure:7': NOW }, 'and so do the acknowledgements');
  assert.deepEqual(loadAuto(home).projects, {});
  // now the other way: the caps flagged, autouse left alone
  setEnabled(home, root, true, NOW);
  saveUserConfig({ ...loadUserConfig(), guardrails: { runWeighted: 70 } });
  assert.equal(userCapsRaw(), undefined);
  resetTamper([home], HOME);
  assert.equal(Object.keys(loadAuto(home).projects).length, 1, 'the switch the user set stays');
  assert.equal(loadUserConfig().guardrails, undefined);
});
