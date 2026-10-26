import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveStage, loadStages, stageStatus } from './engine.ts';

test('8 stages, each with outputs and a task class', () => {
  const s = loadStages();
  assert.equal(s.length, 8);
  assert.deepEqual(s.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(s.every((x) => x.outputs.length && x.taskClass));
});

test('gate: cannot approve without outputs or out of order; approval unlocks the next stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-st-'));
  assert.equal(stageStatus(root)[0]?.state, 'current');
  assert.throws(() => approveStage(root, 1), /missing context\.md/);
  writeFileSync(join(root, 'context.md'), 'x');
  assert.equal(stageStatus(root)[0]?.state, 'ready');
  assert.throws(() => approveStage(root, 2), /approve stage 1 first|missing brief\.md/);
  approveStage(root, 1);
  const st = stageStatus(root);
  assert.equal(st[0]?.state, 'approved'); assert.ok(st[0]?.approvedAt);
  assert.equal(st[1]?.state, 'current');
  writeFileSync(join(root, 'brief.md'), 'y');
  mkdirSync(join(root, 'specs'));
  assert.equal(approveStage(root, 2).state, 'approved');
});
