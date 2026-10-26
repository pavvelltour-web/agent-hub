import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeModeArgs, codexModeArgs } from './modes.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';

test('claudeModeArgs: plan / edit(auto) / full map to --permission-mode', () => {
  assert.deepEqual(claudeModeArgs('plan'), ['--permission-mode', 'plan']);
  assert.deepEqual(claudeModeArgs('edit'), ['--permission-mode', 'auto']);
  assert.deepEqual(claudeModeArgs('full'), ['--permission-mode', 'bypassPermissions']);
});

test('codexModeArgs: a new run uses -s, a resumed run (which has no -s) uses -c sandbox_mode', () => {
  assert.deepEqual(codexModeArgs('edit', false), ['-s', 'workspace-write']);
  assert.deepEqual(codexModeArgs('plan', false), ['-s', 'read-only']);
  assert.deepEqual(codexModeArgs('full', false), ['-s', 'danger-full-access']);
  assert.deepEqual(codexModeArgs('edit', true), ['-c', 'sandbox_mode="workspace-write"']);
  assert.deepEqual(codexModeArgs('plan', true), ['-c', 'sandbox_mode="read-only"']);
  assert.deepEqual(codexModeArgs('full', true), ['-c', 'sandbox_mode="danger-full-access"']);
});

test('codex resume keeps the chosen mode: the sandbox flag is present on resume, absent -s', () => {
  const a = codexAdapter.args({ prompt: 'x', cwd: 'C:\\Проект с пробелом', resumeId: 'abc12345-def', permission: 'edit' });
  assert.deepEqual(a.slice(0, 4), ['exec', 'resume', 'abc12345-def', '--json']);
  assert.ok(a.includes('sandbox_mode="workspace-write"'));
  assert.ok(!a.includes('-s'), 'codex exec resume has no -s');
  const fresh = codexAdapter.args({ prompt: 'x', cwd: 'C:\\x', permission: 'plan' });
  assert.deepEqual(fresh.slice(0, 4), ['exec', '--json', '-s', 'read-only']);
});

test('claude adapter uses the shared mode helper on start and on resume', () => {
  const a = claudeAdapter.args({ prompt: 'x', cwd: 'C:\\x', permission: 'edit', resumeId: 'sid-123456' });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'auto');
  assert.deepEqual(a.slice(a.indexOf('--resume')), ['--resume', 'sid-123456']);
});

test('a prompt and a cwd with a space and Cyrillic never become arguments', () => {
  const prompt = 'Сделай «проект»; rm -rf / && echo $HOME';
  for (const ad of [claudeAdapter, codexAdapter]) {
    const a = ad.args({ prompt, cwd: 'C:\\Users\\Проект с пробелом', permission: 'edit' });
    assert.ok(!a.some((x) => x.includes('Проект') || x.includes('rm -rf')), `${ad.id}: prompt/cwd must go through stdin and spawn cwd, not argv`);
  }
});
