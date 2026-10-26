import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './claude.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-agent.mjs');
const replay = (scenario: string) => spawnSync(process.execPath, [fake], { input: 'hi', encoding: 'utf8', env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_FIXTURE_DELAY: '0' } });

test('fixture replay: the file is printed line by line; "+" chains several files', () => {
  const one = replay('fixture:claude-read.unverified.jsonl');
  assert.equal(one.status, 0);
  assert.equal(one.stdout, readFileSync(join(here, 'fixtures', 'claude-read.unverified.jsonl'), 'utf8').trim() + '\n');
  const two = replay('fixture:claude-read.unverified.jsonl+claude-bash.unverified.jsonl');
  assert.equal(two.stdout.trim().split('\n').length, 4);
});

test('fixture replay: only plain names inside the fixtures folder (no traversal, drive letters, separators, upper case, other extensions)', () => {
  for (const bad of ['../fake-agent.mjs', '..\\fake-agent.mjs', '../fixtures/claude-read.unverified.jsonl', 'C:/Windows/win.ini', 'C:\\x.jsonl', '/etc/passwd', 'sub/claude-read.unverified.jsonl', 'CLAUDE-READ.UNVERIFIED.JSONL', 'claude-read.unverified.jsonl.txt', 'fake-agent.mjs', 'missing.jsonl', '', 'claude-read.unverified.jsonl+../fake-agent.mjs', '%2e%2e%2ffake-agent.mjs.jsonl']) {
    const r = replay('fixture:' + bad);
    assert.equal(r.status, 2, `rejected: ${JSON.stringify(bad)}`);
    assert.equal(r.stdout, '', `nothing printed for ${JSON.stringify(bad)}`);
  }
});

test('the rich fixture parses into every row kind the transcript draws', () => {
  const kinds = new Set<string>();
  for (const line of readFileSync(join(here, 'fixtures', 'claude-session.unverified.jsonl'), 'utf8').split('\n')) if (line.trim()) for (const e of claudeAdapter.parse(JSON.parse(line))) kinds.add(e.kind);
  for (const k of ['thinking', 'text', 'tool', 'tool_result', 'diff', 'todo', 'unknown', 'usage']) assert.ok(kinds.has(k), k);
});
