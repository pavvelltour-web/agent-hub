import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leanArgs } from './lean.ts';
import { claudeAdapter } from '../adapters/claude.ts';

test('lean: a worktree run carries the project profile; rote work drops skills; Codex gets nothing unverified', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-lean-'));
  const wt = mkdtempSync(join(tmpdir(), 'hub-lean-wt-'));
  assert.deepEqual(leanArgs('claude', 'implement', { projectRoot: root, cwd: wt }), [], 'no profile yet: nothing to pass');
  mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.claude', 'settings.local.json'), '{}');
  assert.deepEqual(leanArgs('claude', 'implement', { projectRoot: root, cwd: wt }), ['--settings', join(root, '.claude', 'settings.local.json')]);
  assert.deepEqual(leanArgs('claude', 'implement', { projectRoot: root, cwd: root }), [], 'in the project folder the file applies by itself');
  assert.deepEqual(leanArgs('claude', 'mechanical', { projectRoot: root, cwd: root }), ['--disable-slash-commands']);
  assert.deepEqual(leanArgs('claude', 'summary', { projectRoot: root, cwd: wt }), ['--settings', join(root, '.claude', 'settings.local.json'), '--disable-slash-commands']);
  assert.deepEqual(leanArgs('codex', 'mechanical', { projectRoot: root, cwd: wt }), []);
  const a = claudeAdapter.args({ prompt: 'x', cwd: root, model: 'sonnet', lean: ['--disable-slash-commands'] });
  assert.ok(a.includes('--disable-slash-commands') && a.includes('--model'));
});
