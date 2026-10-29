import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain .mjs script, no type declarations
import { listFolders, parseSummary, renderReport, scratchDir } from '../../scripts/test-all.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

test('parseSummary reads the counters and the failed test names of a node --test run', () => {
  const out = ['✔ fine (1.2ms)', '✖ breaks on purpose (3.4ms)', '✖ second failure (0.5ms)', 'ℹ tests 12', 'ℹ suites 3', 'ℹ pass 9', 'ℹ fail 2', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0', 'ℹ duration_ms 1234.5'].join('\n');
  const s = parseSummary(out);
  assert.deepEqual({ tests: s.tests, pass: s.pass, fail: s.fail, skipped: s.skipped }, { tests: 12, pass: 9, fail: 2, skipped: 1 });
  assert.deepEqual(s.failed, ['breaks on purpose', 'second failure']);
});

test('parseSummary: a run that printed no summary is "unknown", never a pass', () => {
  const s = parseSummary('node: bad option: --nope');
  assert.equal(s.tests, null);
  assert.equal(s.pass, null);
});

test('renderReport marks a folder with no summary or any failure as FAIL and says so in the verdict', () => {
  const rows = [
    { name: 'lib', code: 0, seconds: 1, summary: parseSummary('ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\nℹ cancelled 0') },
    { name: 'run', code: 1, seconds: 2, summary: parseSummary('') },
  ];
  const md = renderReport({ rows, extras: [{ name: 'typecheck', ok: true, note: '' }], env: { node: 'v24.0.0', os: 'win32' }, startedAt: '2026-10-29T00:00:00.000Z' });
  assert.match(md, /\| lib \| 2 \| 2 \| 0 \| 0 \|.*\| PASS \|/);
  assert.match(md, /\| run \|.*\| FAIL \|/);
  assert.match(md, /Verdict: \*\*FAIL\*\*/);
});

test('scratchDir gives the OS spelling of the path (a forward-slash TEMP broke a path comparison in src/review/agents.test.ts) and creates it', () => {
  const base = join(tmpdir(), `ah-scratch-${process.pid}`);
  try {
    const got = scratchDir(`${base.replace(/\\/g, '/')}/a/b`) as string;
    assert.equal(got, resolve(base, 'a', 'b'));
    if (process.platform === 'win32') assert.ok(!got.includes('/'), got);
    assert.ok(existsSync(got));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('listFolders finds every src/ folder that holds tests', () => {
  const found = listFolders(join(ROOT, 'src'));
  for (const f of ['adapters', 'core', 'run', 'server', 'review']) assert.ok(found.includes(f), `missing ${f}`);
  assert.ok(!found.includes('nonexistent'));
});

test('the CI matrix names exactly the folders that hold tests (a new test folder must not be left out of CI)', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const m = /dir:\s*\[([^\]]+)\]/.exec(ci);
  assert.ok(m, 'ci.yml has no `dir: [...]` matrix');
  const inCi = (m[1] as string).split(',').map((x) => x.trim()).filter(Boolean).sort();
  assert.deepEqual(inCi, [...listFolders(join(ROOT, 'src'))].sort());
});
