import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubConfig } from '../core/types.ts';
import { spawnSync } from 'node:child_process';
import { NO_CHECKS_WARNING, MAX_BLOB_BYTES, MAX_PLAN_BYTES, approveChecks, pathProblem, sweepCheckRuns, defaultChecks, dependencyFindings, exportCommit, gateChecks, nodeFiles, planChecks, readReviewConfig, runCheck, runChecks, scanDiffForSecrets } from './checks.ts';
import { checkEnv, minimalEnv } from '../run/git.ts';
import type { CheckResult } from './checks.ts';

const NODE = 'node';
const tmp = (name = 'hub-chk-'): string => mkdtempSync(join(tmpdir(), name));
const withTmp = async (fn: (dir: string) => void | Promise<void>, name?: string): Promise<void> => {
  const dir = tmp(name);
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
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

// ---- trust model: approval of exactly what runs, env, licences, launchers (fixer B) ----------------------------------------------------

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** A project root, a task worktree on hub/t/claude and a temp hub home, all under one temp dir. */
function project(dir: string, base: Record<string, string>): { root: string; wt: string; home: string; commit: (files: Record<string, string>) => string } {
  const root = join(dir, 'repo'); mkdirSync(root, { recursive: true });
  g(root, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries({ 'a.txt': 'a\n', ...base })) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), t); }
  g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'base');
  const wt = join(dir, 'repo-worktrees', 't-claude');
  g(root, 'worktree', 'add', '-q', '-b', 'hub/t/claude', wt);
  const commit = (files: Record<string, string>): string => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), t); } g(wt, 'add', '-A'); g(wt, 'commit', '-q', '-m', 'w'); return g(wt, 'rev-parse', 'HEAD'); };
  return { root, wt, home: join(dir, 'home'), commit };
}

test('planChecks: default npm checks come from the BRANCH HEAD package.json, with their scripts (and npm pre/post) in the digest; nothing is approved by default', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'package.json': JSON.stringify({ scripts: { test: 'node --test', pretest: 'node prep.js', typecheck: 'tsc', build: 'x' } }) });
    const h1 = p.commit({ 'src/x.ts': 'export {};\n' });
    const plan = planChecks(p.root, p.wt, h1, p.home);
    assert.deepEqual(plan.checks, [['npm', 'test'], ['npm', 'run', 'typecheck']]);
    assert.equal(plan.source, 'package.json');
    // stricter (repair C, B3): the screen gets ALL scripts (exactly what the digest covers), plus which of them run
    assert.deepEqual(plan.scripts, { test: 'node --test', pretest: 'node prep.js', typecheck: 'tsc', build: 'x' }, 'every script the digest covers is shown');
    assert.deepEqual(plan.runs, ['pretest', 'test', 'typecheck'], 'the scripts the checks map to, npm pre hook included');
    assert.equal(plan.approved, false, 'nothing runs before the user approves');
    assert.match(plan.digest, /^[0-9a-f]{64}$/);
    assert.match(plan.note, /с вашими правами/);
    assert.throws(() => approveChecks(p.root, p.wt, h1, 'f'.repeat(64), p.home), /changed/);
    assert.equal(planChecks(p.root, p.wt, h1, p.home).approved, false, 'a wrong digest approves nothing');
    assert.equal(approveChecks(p.root, p.wt, h1, plan.digest, p.home).approved, true);
    assert.equal(planChecks(p.root, p.wt, h1, p.home).approved, true);
    const h2 = p.commit({ 'src/y.ts': 'export {};\n' });
    assert.equal(planChecks(p.root, p.wt, h2, p.home).approved, true, 'an unrelated change keeps the approval');
    writeFileSync(join(p.wt, 'package.json'), JSON.stringify({ scripts: { test: 'node evil.js', typecheck: 'tsc' } }));
    assert.equal(planChecks(p.root, p.wt, h2, p.home).approved, true, 'read from the commit, not from the folder');
    // stricter (repair C, B4): and what RUNS is the commit too, never the folder's edit
    const copy = exportCommit(p.wt, h2, p.home, p.root);
    try {
      assert.equal(readFileSync(join(copy.dir, 'package.json'), 'utf8'), JSON.stringify({ scripts: { test: 'node --test', pretest: 'node prep.js', typecheck: 'tsc', build: 'x' } }), 'the checks run the committed package.json');
      assert.ok(!copy.dir.toLowerCase().startsWith(p.wt.toLowerCase()), 'not in the task folder');
    } finally { assert.equal(copy.done(), null); }
    const h3 = p.commit({ 'package.json': JSON.stringify({ scripts: { test: 'node evil.js', pretest: 'node prep.js', typecheck: 'tsc', build: 'x' } }) });
    const changed = planChecks(p.root, p.wt, h3, p.home);
    assert.equal(changed.approved, false, 'a changed test script in the branch needs a new approval');
    assert.notEqual(changed.digest, plan.digest);
    assert.equal(changed.scripts['test'], 'node evil.js');
  });
});

test('planChecks: the security script and node <file> checks are hashed from the branch (a changed script needs re-approval); hub.json of the ROOT sets the list', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'hub.json': JSON.stringify({ review: { checks: [['node', 'verify.mjs'], ['node', '-e', '0']] } }), 'verify.mjs': 'console.log(1)\n' });
    const h1 = p.commit({ 'scripts/security.mjs': 'console.log("sec")\n' });
    const a = planChecks(p.root, p.wt, h1, p.home);
    assert.deepEqual(a.checks, [['node', 'verify.mjs'], ['node', '-e', '0'], ['node', 'scripts/security.mjs']], 'the branch adds scripts/security.mjs: it runs, and is part of the approval');
    assert.equal(a.source, 'hub.json');
    assert.deepEqual(Object.keys(a.files).sort(), ['scripts/security.mjs', 'verify.mjs']);
    approveChecks(p.root, p.wt, h1, a.digest, p.home);
    const h2 = p.commit({ 'scripts/security.mjs': 'console.log("sec, but weaker")\n' });
    assert.equal(planChecks(p.root, p.wt, h2, p.home).approved, false, 'a changed security script needs a new approval');
    const h3 = p.commit({ 'hub.json': JSON.stringify({ review: { checks: [] } }) });
    assert.deepEqual(planChecks(p.root, p.wt, h3, p.home).checks.map((c) => c.join(' ')), ['node verify.mjs', 'node -e 0', 'node scripts/security.mjs'], 'the branch hub.json does not change the list: the root one does');
  });
});

test('planChecks (B3): a list too large to show in full is never approvable; the server refuses the approval', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'package.json': JSON.stringify({ scripts: { test: 'node --test', huge: 'echo ' + 'x'.repeat(MAX_PLAN_BYTES) } }) });
    const h = p.commit({ 'b.txt': 'b\n' });
    const plan = planChecks(p.root, p.wt, h, p.home);
    assert.equal(plan.tooLarge, true); assert.equal(plan.approved, false);
    assert.throws(() => approveChecks(p.root, p.wt, h, plan.digest, p.home), /слишком большой/);
    assert.equal(planChecks(p.root, p.wt, h, p.home).approved, false);
  });
});

test('planChecks (D3): a BOM package.json parses and gives its real digest; broken JSON and a package.json over 1 MB make approval impossible', async () => {
  await withTmp((dir) => {
    const hub = { 'hub.json': JSON.stringify({ review: { checks: [['npm', 'test']] } }) };
    const p = project(dir, { ...hub, 'package.json': '﻿' + JSON.stringify({ scripts: { test: 'node --test' } }) });
    const h1 = p.commit({ 'b.txt': 'b\n' });
    const bom = planChecks(p.root, p.wt, h1, p.home);
    assert.equal(bom.unreadable, null); assert.deepEqual(bom.scripts, { test: 'node --test' }, 'the BOM is dropped as npm does');
    approveChecks(p.root, p.wt, h1, bom.digest, p.home);
    const h2 = p.commit({ 'package.json': '{ "scripts": { "test": "node evil.js" ' });
    const broken = planChecks(p.root, p.wt, h2, p.home);
    assert.match(broken.unreadable ?? '', /package\.json ветки не читается/); assert.equal(broken.approved, false);
    assert.throws(() => approveChecks(p.root, p.wt, h2, broken.digest, p.home), /не читается/);
    const h3 = p.commit({ 'package.json': JSON.stringify({ scripts: { test: 'node evil.js' }, pad: 'x'.repeat(1_100_000) }) });
    const big = planChecks(p.root, p.wt, h3, p.home);
    assert.match(big.unreadable ?? '', /больше 1 МБ/); assert.equal(big.approved, false);
  });
});

test('planChecks (E10): a file the plan must hash over 16 MB makes it unreadable; a plan is cached per commit but the approval is re-read', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'hub.json': JSON.stringify({ review: { checks: [['node', 'big.js']] } }) });
    const h1 = p.commit({ 'big.js': '//' + 'x'.repeat(MAX_BLOB_BYTES + 10) + '\n' });
    const plan = planChecks(p.root, p.wt, h1, p.home);
    assert.match(plan.unreadable ?? '', /16 МБ/); assert.equal(plan.approved, false);
    const h2 = p.commit({ 'big.js': 'console.log(1)\n' });
    const t0 = Date.now(); const a = planChecks(p.root, p.wt, h2, p.home); const first = Date.now() - t0;
    approveChecks(p.root, p.wt, h2, a.digest, p.home);
    const t1 = Date.now(); const b = planChecks(p.root, p.wt, h2, p.home); const second = Date.now() - t1;
    assert.equal(b.approved, true, 'the approval is not cached'); assert.equal(b.digest, a.digest);
    assert.ok(second <= first, `cached plan (${second} ms) is not slower than the first (${first} ms)`);
  });
});

test('pathProblem (E1): case-only differences on Windows/macOS, reserved names and ":" on Windows; Linux keeps them', () => {
  assert.match(pathProblem(['src/Test.js', 'src/test.js'], 'win32') ?? '', /регистром/);
  assert.match(pathProblem(['src/Test.js', 'src/test.js'], 'darwin') ?? '', /регистром/);
  assert.equal(pathProblem(['src/Test.js', 'src/test.js'], 'linux'), null);
  for (const p of ['a/con.js', 'NUL', 'a/b:stream', 'dir./x.js', 'x ']) assert.match(pathProblem([p], 'win32') ?? '', /недопустим/, p);
  assert.equal(pathProblem(['src/a.js', 'console.js', 'nullable.ts'], 'win32'), null);
});

test('exportCommit (E1, E2): a commit with case-clashing paths is refused on Windows; a node_modules committed to the branch never comes along', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'check.js': '1\n' });
    const h = p.commit({ 'node_modules/evil/index.js': 'evil\n', 'pkg/node_modules/x/i.js': 'x\n' });
    const copy = exportCommit(p.wt, h, p.home, p.root);
    try {
      assert.equal(existsSync(join(copy.dir, 'node_modules')), false, 'no root node_modules and the branch one is dropped');
      assert.equal(existsSync(join(copy.dir, 'pkg', 'node_modules')), false);
      assert.equal(existsSync(join(copy.dir, 'check.js')), true);
    } finally { assert.equal(copy.done(), null); }
    if (process.platform === 'win32') {
      const blob = g(p.wt, 'hash-object', '-w', '--stdin');
      g(p.wt, 'update-index', '--add', '--cacheinfo', `100644,${blob},src/Test.js`); g(p.wt, 'update-index', '--add', '--cacheinfo', `100644,${blob},src/test.js`);
      g(p.wt, 'commit', '-q', '-m', 'clash');
      assert.throws(() => exportCommit(p.wt, g(p.wt, 'rev-parse', 'HEAD'), p.home, p.root), /регистром/);
      assert.deepEqual(readdirSync(join(p.home, 'check-runs')), [], 'the refused copy is removed');
    }
  });
});

test('sweepCheckRuns (E5): old copies go, the node_modules link is taken off first (the root install survives), fresh copies stay', async () => {
  await withTmp((dir) => {
    const home = join(dir, 'home'), rootNm = join(dir, 'root', 'node_modules');
    mkdirSync(join(rootNm, 'pkg'), { recursive: true }); writeFileSync(join(rootNm, 'pkg', 'index.js'), 'keep');
    const old = join(home, 'check-runs', 'c-old'), fresh = join(home, 'check-runs', 'c-new');
    mkdirSync(join(old, 'tree'), { recursive: true }); mkdirSync(join(fresh, 'tree'), { recursive: true });
    symlinkSync(rootNm, join(old, 'tree', 'node_modules'), 'junction');
    const past = new Date(Date.now() - 2 * 3_600_000); utimesSync(old, past, past);
    assert.deepEqual(sweepCheckRuns(home), []);
    assert.equal(existsSync(old), false); assert.equal(existsSync(fresh), true);
    assert.equal(readFileSync(join(rootNm, 'pkg', 'index.js'), 'utf8'), 'keep', 'never deleted through the link');
  });
});

test('nodeFiles (F9): the script, file arguments and -r/--require/--import/--loader/--env-file paths are hashed; option values and packages are not', () => {
  assert.deepEqual(nodeFiles(['--import', 'tsx', 'x.ts']), ['x.ts']);
  assert.deepEqual(nodeFiles(['-r', './a.js', 'b.js', 'data.json']), ['a.js', 'b.js', 'data.json']);
  assert.deepEqual(nodeFiles(['--require=./pre.cjs', '--env-file', '.env.test.json', '--conditions', 'dev.js', 'main.mjs']), ['pre.cjs', '.env.test.json', 'main.mjs']);
  assert.deepEqual(nodeFiles(['--test', 'src/**/*.test.ts']), [], 'globs are not files');
  assert.deepEqual(nodeFiles(['-e', 'require("./x.js")']), [], 'inline code is in the argv itself');
  assert.deepEqual(nodeFiles(['--loader', 'ts-node/esm', 'scripts\\security.mjs']), ['scripts/security.mjs']);
});

test('planChecks (F9): `npm run x` inside scripts is followed (pre/post, 3 levels) and the node files those scripts start are in the digest', async () => {
  await withTmp((dir) => {
    const scripts = { test: 'npm run build && node scripts/t.mjs', prebuild: 'node pre.js', build: 'npm run gen', gen: 'node -r ./hook.cjs gen.js', unrelated: 'node other.js' };
    const p = project(dir, { 'package.json': JSON.stringify({ scripts }), 'scripts/t.mjs': '1\n', 'pre.js': '1\n', 'gen.js': '1\n', 'hook.cjs': '1\n', 'other.js': '1\n' });
    const h = p.commit({ 'b.txt': 'b\n' });
    const plan = planChecks(p.root, p.wt, h, p.home);
    assert.deepEqual(plan.runs, ['test', 'prebuild', 'build', 'gen']);
    assert.deepEqual(Object.keys(plan.files).sort(), ['.npmrc', 'gen.js', 'hook.cjs', 'pre.js', 'scripts/t.mjs']);
    approveChecks(p.root, p.wt, h, plan.digest, p.home);
    const h2 = p.commit({ 'hook.cjs': 'changed\n' });
    assert.equal(planChecks(p.root, p.wt, h2, p.home).approved, false, 'a changed file three scripts deep needs a new approval');
    approveChecks(p.root, p.wt, h2, planChecks(p.root, p.wt, h2, p.home).digest, p.home);
    const h3 = p.commit({ 'other.js': 'changed\n' });
    assert.equal(planChecks(p.root, p.wt, h3, p.home).approved, true, 'a file no reached script starts does not');
  });
});

test('exportCommit (B4): the copy is the commit\'s bytes; skip-worktree edits, ignored files and the branch node_modules stay out; the root node_modules is linked and survives removal', async () => {
  await withTmp((dir) => {
    const p = project(dir, { 'check.js': 'console.log("committed")\n', '.gitignore': '.npmrc\nnode_modules/\n', '.gitattributes': '* text eol=crlf\n' });
    const h = p.commit({ 'b.txt': 'b\n' });
    g(p.wt, 'update-index', '--skip-worktree', 'check.js');
    writeFileSync(join(p.wt, 'check.js'), 'console.log("evil")\n');
    writeFileSync(join(p.wt, '.npmrc'), 'script-shell=evil.exe\n');
    mkdirSync(join(p.wt, 'node_modules', 'planted'), { recursive: true });
    mkdirSync(join(p.root, 'node_modules', 'real'), { recursive: true }); writeFileSync(join(p.root, 'node_modules', 'real', 'index.js'), 'ok');
    const copy = exportCommit(p.wt, h, p.home, p.root);
    try {
      assert.equal(readFileSync(join(copy.dir, 'check.js'), 'utf8'), 'console.log("committed")\n', 'exact blob bytes (no eol conversion, no skip-worktree edit)');
      assert.equal(existsSync(join(copy.dir, '.npmrc')), false, 'no ignored file of the task folder');
      assert.equal(existsSync(join(copy.dir, 'node_modules', 'planted')), false, 'not the branch node_modules');
      assert.equal(existsSync(join(copy.dir, 'node_modules', 'real', 'index.js')), true, 'the root node_modules is linked');
      assert.equal(g(p.wt, 'status', '--porcelain'), '', 'the task folder index is untouched');
    } finally { assert.equal(copy.done(), null); }
    assert.equal(existsSync(join(p.root, 'node_modules', 'real', 'index.js')), true, 'removing the copy never deletes through the link');
    assert.deepEqual(readdirSync(join(p.home, 'check-runs')), []);
  });
});

test('checkEnv (F10): an allowlist: tokens, API keys, NODE_OPTIONS and npm_config_* never reach a check; node and npm still start', async () => {
  await withTmp(async (dir) => {
    const secrets = { GITHUB_TOKEN: 'gh-x', NPM_TOKEN: 'npm-x', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'a-x', AWS_SECRET_ACCESS_KEY: 'aws-x', NODE_OPTIONS: '--require ./evil.js', npm_config_script_shell: 'evil.exe', HUB_SESSION_TOKEN: 'h-x' };
    const env = checkEnv(join(dir, 'home'), { ...process.env, ...secrets });
    for (const k of Object.keys(secrets)) assert.equal(env[k], undefined, k);
    assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')); assert.equal(env['CI'], '1'); assert.equal(env['NoDefaultCurrentDirectoryInExePath'], '1', 'cmd.exe does not run node.cmd/tsc.cmd from the copy folder'); assert.equal(env['GIT_CONFIG_KEY_0'], 'core.hooksPath');
    const [r] = await runChecks(dir, [js('console.log(Object.keys(process.env).filter((k) => /token|api_key|secret|node_options|npm_config/i.test(k)).join(",") || "none")')], { env });
    assert.equal(r?.ok, true); assert.match(r!.tail, /^none$/m);
    const npm = await runCheck(dir, ['npm', '--version'], 60_000, env);
    assert.equal(npm.ok, true, npm.tail);
    assert.deepEqual(Object.keys(minimalEnv({ Path: 'p', SystemRoot: 's', FOO: 'x' })).sort(), ['CI', 'Path', 'SystemRoot']);
  });
});

test('planChecks: no checks at all is "approved" (nothing runs) and flagged noTests; only the security script is noTests too', async () => {
  await withTmp((dir) => {
    const p = project(dir, {});
    const h = p.commit({ 'b.txt': 'b\n' });
    const none = planChecks(p.root, p.wt, h, p.home);
    assert.deepEqual(none.checks, []); assert.equal(none.approved, true); assert.equal(none.noTests, true); assert.equal(none.source, 'none');
    const h2 = p.commit({ 'scripts/security.mjs': '\n' });
    assert.equal(planChecks(p.root, p.wt, h2, p.home).noTests, true);
    assert.match(NO_CHECKS_WARNING, /Нет проверок/);
  });
});

test('runCheck: the env given is what the check sees (the gate passes one without hub secrets); PATH still works', async () => {
  await withTmp(async (dir) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MARK_X: 'given' };
    delete env['HUB_SESSION_TOKEN'];
    const [r] = await runChecks(dir, [js('console.log("tok=" + (process.env.HUB_SESSION_TOKEN || "none") + " mark=" + process.env.MARK_X + " path=" + !!(process.env.PATH || process.env.Path))')], { env });
    assert.equal(r?.ok, true); assert.match(r!.tail, /tok=none mark=given path=true/);
  });
});

test('runCheck on Windows: a .cmd launcher is refused with a plain hint (no shell); a missing one says to give the full path', { skip: process.platform !== 'win32' }, async () => {
  await withTmp(async (dir) => {
    writeFileSync(join(dir, 'fakepm.cmd'), '@echo pwned\r\n');
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    env['PATH'] = dir;
    const r = await runCheck(dir, ['fakepm', 'test'], 10_000, env);
    assert.equal(r.ok, false); assert.match(r.tail, /could not start/); assert.match(r.tail, /\.cmd/); assert.match(r.tail, /полный путь/); assert.doesNotMatch(r.tail, /pwned/);
    const direct = await runCheck(dir, [join(dir, 'fakepm.cmd')], 10_000, env);
    assert.equal(direct.ok, false); assert.match(direct.tail, /\.cmd/);
    const missing = await runCheck(dir, ['no-such-runner-xyz'], 10_000, env);
    assert.match(missing.tail, /не найден запускатель no-such-runner-xyz; укажите полный путь в hub\.json review\.checks/);
  });
});

test('dependencyFindings: a licence planted in the task folder node_modules is not trusted; only the project root copy (with a registry spec) or the tiny built-in list clear it', async () => {
  await withTmp((dir) => {
    const root = join(dir, 'root'), wt = join(dir, 'wt');
    const lic = (base: string, name: string, license: string): void => { mkdirSync(join(base, 'node_modules', name), { recursive: true }); writeFileSync(join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, license })); };
    lic(wt, 'evil-pkg', 'MIT');          // agent-planted, git-ignored, never reviewed
    lic(root, 'good-pkg', 'MIT'); lic(root, 'aliased', 'MIT');
    const diff = addDiff([' {', '   "dependencies": {', '+    "evil-pkg": "^1.0.0",', '+    "good-pkg": "^1.0.0",', '+    "typescript": "^5.9.0",', '+    "aliased": "npm:good-pkg@1"']);
    const f = dependencyFindings(diff, root);
    assert.deepEqual(f.map((x) => /"([^"]+)"/.exec(x.title)?.[1]).sort(), ['aliased', 'evil-pkg'], 'the planted MIT licence does not clear evil-pkg; a non-registry spec is never cleared');
    assert.ok(f.every((x) => x.lens === 'security'));
    assert.match(f.find((x) => x.title.includes('evil-pkg'))!.evidence, /task folder's node_modules is never trusted/);
    assert.match(f.find((x) => x.title.includes('aliased'))!.title, /non-registry/);
  });
});
