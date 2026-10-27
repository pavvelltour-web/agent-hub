import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Review fix 4: the hub remembers a hash of what it last wrote into its own settings files; a change made by anything else is tamper, not configuration.
const base = mkdtempSync(join(tmpdir(), 'hub-integ-'));
process.env['USERPROFILE'] = base; process.env['HOME'] = base; process.env['AGENT_HUB_HOME'] = join(base, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const HOME = process.env['AGENT_HUB_HOME'] as string;
const { AutoScheduler, loadAuto, loadAutoRaw, saveAuto, setEnabled, approveItem } = await import('./autouse.ts');
const { tamperList, resetTamper } = await import('./integrity.ts');
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
