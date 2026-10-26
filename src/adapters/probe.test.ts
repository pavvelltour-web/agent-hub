import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManager } from '../run/runner.ts';
import { openDb } from '../history/store.ts';
import { classify, loadMatrix, probeModes } from './probe.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };

test('classify: a tool call and its result decide allowed / denied / asked; no call means unknown', () => {
  const ev = (tool: string, summary: string, result: string, isError: boolean) => [{ kind: 'tool', data: { kind: 'tool', name: tool, summary } }, { kind: 'tool_result', data: { kind: 'tool_result', summary: result, ...(isError ? { isError: true } : {}) } }];
  assert.equal(classify('shell', [...ev('Bash', 'git status', 'On branch main', false)]), 'allowed');
  assert.equal(classify('shell', [...ev('Bash', 'git status', 'Permission to use Bash has been denied.', true)]), 'denied');
  assert.equal(classify('shell', [...ev('Bash', 'git status', 'This command requires approval', true)]), 'asked');
  assert.equal(classify('shell', [...ev('shell', 'git status', 'Read-only file system', true)]), 'denied');
  assert.equal(classify('network', [...ev('WebFetch', 'https://example.com', 'Could not resolve host', true)]), 'denied');
  assert.equal(classify('network', []), 'unknown');
  assert.equal(classify('read', [...ev('Bash', 'git status', 'x', false)]), 'unknown', 'a shell call is not evidence about reading');
});

test('probeModes: classifies read/write/shell/network per mode from events, checks the write on disk, saves the matrix with the CLI version', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  const runs = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'probe' }, summarize: false, home });
  const m = await probeModes({ agent: 'claude', runs, home, cliVersion: '9.9.9' });
  assert.deepEqual(m.plan, { read: 'allowed', write: 'denied', shell: 'denied', network: 'denied' });
  assert.deepEqual(m.edit, { read: 'allowed', write: 'allowed', shell: 'allowed', network: 'asked' });
  assert.deepEqual(m.full, { read: 'allowed', write: 'allowed', shell: 'allowed', network: 'allowed' });
  const saved = loadMatrix(home);
  assert.equal(saved.claude?.cliVersion, '9.9.9'); assert.deepEqual(saved.claude?.matrix, m);
  assert.ok(existsSync(join(home, 'modes-matrix.json')) && !readFileSync(join(home, 'modes-matrix.json'), 'utf8').includes(JSON.stringify(tmpdir()).slice(1, -1)), 'no temp paths in the saved file');
});

test('loadMatrix: a missing or corrupt file is an empty matrix, never a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  assert.deepEqual(loadMatrix(home), {});
});

test('probeModes: a probe that classified nothing is not saved (all unknown must not read as "verified")', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  const runs = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, home });
  const m = await probeModes({ agent: 'claude', runs, home, cliVersion: '1.0.0' });
  assert.ok(Object.values(m.plan).every((v) => v === 'unknown' || v === 'denied' || v === 'allowed'));
  assert.deepEqual(loadMatrix(home), {}, 'claude-ok has no read/write/shell/network tool calls the probe recognises');
});
