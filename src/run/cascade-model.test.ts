import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The cascade card's data layer is DOM-free (plain web JS), so the hostile-data rules are checked in node.
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'cascade-model.js')).href) as { cascadeModel: (r: unknown) => any; stepsLine: (m: unknown) => string; modelName: (m: unknown) => string };

const good = { cascade: { id: 'rab12', status: 'stopped', verify: ['npm', 'test'], reason: 'BLOCKED: x', rungs: [
  { runId: 'rab12', role: 'executor', model: 'claude-sonnet-5-5', verifyPassed: false, tail: 'FAIL a' },
  { runId: 'rab13', role: 'executor', repair: true, model: 'claude-sonnet-5-5', verifyPassed: false },
  { runId: 'rab14', role: 'stuck-review', model: 'claude-opus-5-5', verifyPassed: false },
  { runId: 'rab15', role: 'fixer', model: 'claude-opus-5-5', verifyPassed: true },
] } };

test('cascadeModel: steps, verify state per step, and the one-line story', () => {
  const m = M.cascadeModel(good);
  assert.equal(M.stepsLine(m), 'Sonnet пишет → Opus разбирает → Opus правит');
  assert.deepEqual(m.rungs.map((r: any) => r.verify), ['failed', 'failed', 'none', 'passed']);
  assert.equal(m.rungs[1].repair, true); assert.match(m.rungs[1].who, /Sonnet дорабатывает/);
  const b = M.cascadeModel({ cascade: { ...good.cascade, rungs: [{ runId: 'rab12', role: 'executor', verifyPassed: true, blocked: 'weakens the checks' }] } });
  assert.equal(b.rungs[0].verify, 'blocked', 'a blocked rung is never shown as passed');
});

test('cascadeModel: hostile or malformed data is read by type, never thrown on or stringified', () => {
  assert.equal(M.cascadeModel(null), null); assert.equal(M.cascadeModel({}), null); assert.equal(M.cascadeModel({ cascade: { status: 'hacked' } }), null);
  assert.equal(M.cascadeModel({ cascade: { status: '__proto__' } }), null);
  const m = M.cascadeModel({ cascade: { status: 'running', id: { toString: 'x' }, reason: { a: 1 }, card: ['x'], verify: [{ a: 1 }, 'ok'], rungs: [null, 5, { runId: '../x', role: { a: 1 }, model: { a: 1 }, blocked: { a: 1 }, tail: { a: 1 }, note: 7, verifyPassed: 'true' }] } });
  assert.equal(m.id, ''); assert.equal(m.reason, ''); assert.equal(m.card, ''); assert.deepEqual(m.verify, ['', 'ok']);
  assert.equal(m.rungs.length, 1); assert.equal(m.rungs[0].runId, ''); assert.equal(m.rungs[0].verify, 'failed'); assert.equal(m.rungs[0].tail, '');
  assert.equal(M.modelName('<img src=x onerror=1>'), 'imgsrcxonerror1'); assert.equal(M.modelName({}), 'агент');
});
