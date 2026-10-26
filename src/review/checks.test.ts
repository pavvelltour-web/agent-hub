import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubConfig } from '../core/types.ts';
import { defaultChecks, dependencyFindings, gateChecks, readReviewConfig, runChecks, scanDiffForSecrets } from './checks.ts';
import type { CheckResult } from './checks.ts';

const NODE = 'node';
const tmp = (name = 'hub-chk-'): string => mkdtempSync(join(tmpdir(), name));
const withTmp = async (fn: (dir: string) => void | Promise<void>, name?: string): Promise<void> => {
  const dir = tmp(name);
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const js = (code: string, ...args: string[]): string[] => [NODE, '-e', code, ...args];

// secret-looking values are built at run time so this file carries no secret literal
const GH = 'ghp_' + 'A1'.repeat(18);
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';

test('HubConfig accepts review settings', () => {
  const c: HubConfig = { version: 1, project: { slug: 'x', type: 'node' }, agents: [], rules: { source: 'AGENTS.md', claudePointer: true }, limits: { handoffThresholdPercent: 80, autoHandoff: false }, review: { effort: 'deep', checks: [['npm', 'test']], humanPaths: ['src/econ/**'] } };
  assert.equal(c.review?.effort, 'deep');
});

test('runChecks: a passing check is ok and shows its output', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('console.log("hello check")')]);
    assert.equal(r?.ok, true);
    assert.match(r!.tail, /hello check/);
  });
});

test('runChecks: a failing check is red and says the exit code', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('console.error("boom"); process.exit(3)')]);
    assert.equal(r?.ok, false);
    assert.match(r!.tail, /boom/);
    assert.match(r!.tail, /exit code 3/);
  });
});

test('runChecks: the tail is the last 40 lines only', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('for (let i = 1; i <= 100; i++) console.log("line" + i)')]);
    assert.doesNotMatch(r!.tail, /\bline60\b/);
    assert.match(r!.tail, /\bline61\b/);
    assert.match(r!.tail, /\bline100\b/);
    assert.ok(r!.tail.split('\n').length <= 42);
  });
});

test('runChecks: secrets in the output are redacted', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('console.log("token " + process.argv[1])', GH)]);
    assert.doesNotMatch(r!.tail, new RegExp(GH));
    assert.match(r!.tail, /REDACTED/);
  });
});

test('runChecks: the check name never carries a secret argument', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('0', GH)]);
    assert.doesNotMatch(r!.name, new RegExp(GH));
  });
});

test('runChecks: spaces and Cyrillic in the cwd work, and node resolves to this node', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [js('console.log(process.cwd()); console.log(process.execPath)')]);
    assert.equal(r?.ok, true);
    assert.match(r!.tail, /папка с пробелами/);
    assert.ok(r!.tail.includes(process.execPath));
  }, 'hub chk папка с пробелами ');
});

test('runChecks: argv is passed as is, with no shell', async () => {
  await withTmp(async (dir) => {
    const weird = 'a & echo pwned | b; "c" $HOME %PATH%';
    const [r] = await runChecks(dir, [js('console.log(process.argv[1])', weird)]);
    assert.ok(r!.tail.includes(weird));
  });
});

test('runChecks: a missing program is a red check, not an exception', async () => {
  await withTmp(async (dir) => {
    const [r] = await runChecks(dir, [['definitely-not-a-program-xyz', '--version']]);
    assert.equal(r?.ok, false);
    assert.match(r!.tail, /could not start/);
  });
});

test('runChecks: malformed checks are red, never thrown', async () => {
  await withTmp(async (dir) => {
    const out = await runChecks(dir, [[], [''], ['node', 5 as unknown as string], ['no\0de']]);
    assert.equal(out.length, 4);
    assert.ok(out.every((r) => !r.ok));
  });
});

test('runChecks: a check that overruns its timeout is killed', async () => {
  await withTmp(async (dir) => {
    const pidFile = join(dir, 'pid.txt');
    const t0 = Date.now();
    const [r] = await runChecks(dir, [js('require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)', pidFile)], { timeoutMs: 1500 });
    assert.equal(r?.ok, false);
    assert.match(r!.tail, /timed out/);
    assert.ok(Date.now() - t0 < 15_000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the timed-out process must be gone');
  });
});

test('gateChecks: a red check closes the gate and later checks never run', async () => {
  await withTmp(async (dir) => {
    const ran: string[] = [];
    const run = async (_cwd: string, argv: string[]): Promise<CheckResult> => { ran.push(argv[0]!); return { name: argv[0]!, ok: argv[0] !== 'red', tail: '' }; };
    const g = await gateChecks(dir, [['green1'], ['red'], ['never']], { run });
    assert.equal(g.ok, false);
    assert.deepEqual(ran, ['green1', 'red']);
    assert.deepEqual(g.results.map((r) => r.ok), [true, false]);
  });
});

test('gateChecks: all green opens the gate', async () => {
  await withTmp(async (dir) => {
    const run = async (_c: string, argv: string[]): Promise<CheckResult> => ({ name: argv[0]!, ok: true, tail: '' });
    const g = await gateChecks(dir, [['a'], ['b']], { run });
    assert.equal(g.ok, true);
    assert.equal(g.results.length, 2);
  });
});

test('gateChecks: a secret in the diff is red before any command runs', async () => {
  await withTmp(async (dir) => {
    let ran = 0;
    const run = async (): Promise<CheckResult> => { ran++; return { name: 'x', ok: true, tail: '' }; };
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', `+const k = "${GH}"`].join('\n');
    const g = await gateChecks(dir, [['a']], { run, diffText: diff });
    assert.equal(g.ok, false);
    assert.equal(ran, 0);
    assert.equal(g.results[0]?.name, 'secret-scan');
    assert.doesNotMatch(JSON.stringify(g.results), new RegExp(GH));
  });
});

test('gateChecks: a real command that fails closes the gate (end to end)', async () => {
  await withTmp(async (dir) => {
    const g = await gateChecks(dir, [js('process.exit(1)'), js('console.log("second")')]);
    assert.equal(g.ok, false);
    assert.equal(g.results.length, 1);
  });
});

test('gateChecks: an added dependency is reported as an informational check', async () => {
  await withTmp(async (dir) => {
    const diff = ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -1,3 +1,4 @@', ' {', '   "dependencies": {', '+    "left-pad": "^1.3.0"', '   }'].join('\n');
    const run = async (): Promise<CheckResult> => ({ name: 'x', ok: true, tail: '' });
    const g = await gateChecks(dir, [], { run, diffText: diff });
    const dep = g.results.find((r) => r.name === 'new-dependency');
    assert.ok(dep);
    assert.equal(dep.ok, true);
    assert.match(dep.tail, /left-pad/);
  });
});

const addDiff = (lines: string[], file = 'package.json'): string => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,4 +1,5 @@', ...lines].join('\n');

test('scanDiffForSecrets: an added secret is red and the tail names the kind and file but not the value', () => {
  const r = scanDiffForSecrets(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', ' ok', `+const aws = "${AWS}"`, `+const gh = "${GH}"`].join('\n'));
  assert.equal(r.name, 'secret-scan');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.tail, new RegExp(AWS));
  assert.doesNotMatch(r.tail, new RegExp(GH));
  assert.match(r.tail, /aws-key/);
  assert.match(r.tail, /src\/a\.ts/);
});

test('scanDiffForSecrets: a removed secret, and a clean diff, are green', () => {
  assert.equal(scanDiffForSecrets(addDiff(['-const k = "' + GH + '"', '+const k = process.env.K'], 'src/a.ts')).ok, true);
  assert.equal(scanDiffForSecrets(addDiff(['+const a = 1'], 'src/a.ts')).ok, true);
  assert.equal(scanDiffForSecrets('').ok, true);
});

test('scanDiffForSecrets: touching a secret path is red; example env files are not', () => {
  const env = ['diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+A=1'].join('\n');
  const r = scanDiffForSecrets(env);
  assert.equal(r.ok, false);
  assert.match(r.tail, /\.env/);
  const auth = ['diff --git a/home/auth.json b/home/auth.json', '--- a/home/auth.json', '+++ b/home/auth.json', '@@ -1 +1 @@', '-1', '+2'].join('\n');
  assert.equal(scanDiffForSecrets(auth).ok, false);
  const ex = ['diff --git a/.env.example b/.env.example', '--- a/.env.example', '+++ b/.env.example', '@@ -1 +1 @@', '-A=', '+A=x'].join('\n');
  assert.equal(scanDiffForSecrets(ex).ok, true);
});

test('scanDiffForSecrets: a secret on a line that looks like a +++ header, or after a broken hunk header, is still found', () => {
  assert.equal(scanDiffForSecrets(addDiff([`+++ ${GH}`])).ok, false);
  assert.equal(scanDiffForSecrets(['@@ -1 +1 @@', '+x', `+k = "${GH}"`].join('\n')).ok, false);
});

test('dependencyFindings: a new dependency that is not installed has an unknown license -> security finding with the right line', async () => {
  await withTmp((dir) => {
    const f = dependencyFindings(addDiff([' {', '   "devDependencies": {', '     "@types/node": "^24.0.0",', '+    "left-pad": "^1.3.0",', '     "typescript": "^5.9.0"']), dir);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.lens, 'security');
    assert.equal(f[0]?.category, 'risk');
    assert.equal(f[0]?.file, 'package.json');
    assert.equal(f[0]?.line, 4);
    assert.match(f[0]!.title, /left-pad/);
    assert.match(f[0]!.title, /unknown/i);
  });
});

test('dependencyFindings: an installed dependency with an allow-listed license is fine; a copyleft or odd one is not', async () => {
  await withTmp((dir) => {
    const lic = (name: string, license: unknown): void => { mkdirSync(join(dir, 'node_modules', name), { recursive: true }); writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, license })); };
    lic('ok-mit', 'MIT'); lic('ok-or', '(MIT OR GPL-3.0-only)'); lic('bad-gpl', 'GPL-3.0'); lic('odd', 'SEE LICENSE IN LICENSE.txt'); lic('and-bad', '(MIT AND GPL-3.0)');
    const diff = addDiff([' {', '   "dependencies": {', '+    "ok-mit": "1.0.0",', '+    "ok-or": "1.0.0",', '+    "bad-gpl": "1.0.0",', '+    "odd": "1.0.0",', '+    "and-bad": "1.0.0"']);
    const names = dependencyFindings(diff, dir).map((f) => /"([^"]+)"/.exec(f.title)?.[1]).sort();
    assert.deepEqual(names, ['and-bad', 'bad-gpl', 'odd']);
  });
});

test('dependencyFindings: version bumps, scripts, version and engines are not new dependencies', () => {
  const diff = addDiff([' {', '-  "version": "0.1.0",', '+  "version": "0.2.0",', '   "scripts": {', '+    "test": "node --test",', '   },', '   "engines": {', '+    "node": ">=24"', '   },', '   "devDependencies": {', '-    "typescript": "^5.8.0"', '+    "typescript": "^5.9.0"']);
  assert.deepEqual(dependencyFindings(diff, tmpdir()), []);
});

test('dependencyFindings: a hunk that starts inside a dependency block still finds a version-looking addition', () => {
  const diff = ['diff --git a/pkg/package.json b/pkg/package.json', '--- a/pkg/package.json', '+++ b/pkg/package.json', '@@ -20,2 +20,3 @@', '     "a": "1.0.0",', '+    "brand-new": "^2.0.0",', '     "b": "1.0.0"'].join('\n');
  const f = dependencyFindings(diff, tmpdir());
  assert.equal(f.length, 1);
  assert.equal(f[0]?.file, 'pkg/package.json');
});

test('dependencyFindings: other files and hostile names never read outside node_modules', async () => {
  await withTmp((dir) => {
    const outside = join(dir, 'secret-outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ license: 'MIT' }));
    mkdirSync(join(dir, 'node_modules'));
    const diff = addDiff([' {', '   "dependencies": {', '+    "../secret-outside": "1.0.0",', '+    "..\\\\..\\\\x": "1.0.0",', '+    "l\\u0065ft-pad": "1.0.0"']);
    const f = dependencyFindings(diff, dir);
    assert.equal(f.length, 3);
    assert.ok(f.some((x) => x.title.includes('"left-pad"')), 'a JSON-escaped name is decoded, not skipped');
    assert.ok(f.every((x) => /unknown/i.test(x.title)));
    assert.deepEqual(dependencyFindings(addDiff(['+    "left-pad": "^1.3.0"'], 'src/data.json'), dir), []);
  });
});

test('defaultChecks: test and typecheck scripts, plus the security script when it exists', async () => {
  await withTmp((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', typecheck: 'y', build: 'z' } }));
    assert.deepEqual(defaultChecks(dir), [['npm', 'test'], ['npm', 'run', 'typecheck']]);
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'security.mjs'), '');
    assert.deepEqual(defaultChecks(dir).at(-1), ['node', 'scripts/security.mjs']);
  });
});

test('defaultChecks: hub.json review.checks replace the script detection; nothing known gives an empty list', async () => {
  await withTmp((dir) => {
    assert.deepEqual(defaultChecks(dir), []);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    writeFileSync(join(dir, 'hub.json'), JSON.stringify({ review: { checks: [['node', 'verify.js']] } }));
    assert.deepEqual(defaultChecks(dir), [['node', 'verify.js']]);
  });
});

test('defaultChecks: broken package.json or hub.json do not throw', async () => {
  await withTmp((dir) => {
    writeFileSync(join(dir, 'package.json'), '{nope');
    writeFileSync(join(dir, 'hub.json'), '[1,');
    assert.deepEqual(defaultChecks(dir), []);
  });
});

test('readReviewConfig: tolerates unknown keys, drops malformed values', async () => {
  await withTmp((dir) => {
    assert.deepEqual(readReviewConfig(dir), {});
    writeFileSync(join(dir, 'hub.json'), JSON.stringify({ version: 1, future: { a: 1 }, review: { effort: 'deep', checks: [['npm', 'test'], 'bad', [1], []], humanPaths: ['a/**', 5], extra: true } }));
    assert.deepEqual(readReviewConfig(dir), { effort: 'deep', checks: [['npm', 'test']], humanPaths: ['a/**'] });
    writeFileSync(join(dir, 'hub.json'), JSON.stringify({ review: 'nope' }));
    assert.deepEqual(readReviewConfig(dir), {});
  });
});
