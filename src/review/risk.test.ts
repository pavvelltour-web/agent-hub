import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globMatch, riskTier } from './risk.ts';

const tier = (paths: string[], humanPaths: string[] = []) => riskTier(paths, { humanPaths });

test('risk: CI workflow is high', () => {
  const r = tier(['.github/workflows/x.yml']);
  assert.equal(r.tier, 'high');
  assert.ok(r.why.length > 0);
});

test('risk: README.md only is low', () => {
  assert.equal(tier(['README.md']).tier, 'low');
});

test('risk: docs, markdown and images only is low', () => {
  assert.equal(tier(['docs/adr/019-x.md', 'docs/diagram.ts', 'web/logo.PNG', 'notes/a.md']).tier, 'low');
});

test('risk: docs plus one code file is medium', () => {
  assert.equal(tier(['README.md', 'src/lib/title.ts']).tier, 'medium');
});

test('risk: no changed paths is low and says why', () => {
  const r = tier([]);
  assert.equal(r.tier, 'low');
  assert.ok(r.why.length > 0);
});

test('risk: AGENTS.md, CLAUDE.md and rules files are high', () => {
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'sub/AGENTS.md', 'rules/style.md', 'rules/deep/x.json', '.claude/settings.json']) assert.equal(tier([p]).tier, 'high', p);
});

test('risk: manifests, lockfiles, migrations, hooks, installers are high', () => {
  for (const p of ['package.json', 'pkg/a/package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'db/migrations/001.sql', 'src/run/hooks-run.ts', '.husky/pre-commit', 'scripts/install.ps1', 'setup/installer.ts']) {
    assert.equal(tier([p]).tier, 'high', p);
  }
});

test('risk: auth, keys, payments, billing and deletion code is high', () => {
  for (const p of ['src/auth/login.ts', 'src/server/oauth.ts', 'src/keys/store.ts', 'src/payments/charge.ts', 'src/billing.ts', 'src/core/delete-account.ts', 'src/lib/credentials.ts']) {
    assert.equal(tier([p]).tier, 'high', p);
  }
});

test('risk: an ordinary source file is medium, and lookalike names are not high', () => {
  for (const p of ['src/lib/title.ts', 'src/ui/keyboard.ts', 'design/tokens.css', 'src/review/triage.ts']) assert.equal(tier([p]).tier, 'medium', p);
});

test('risk: owner-listed humanPaths are high, with * ** ? globs', () => {
  assert.equal(tier(['src/econ/pricing.ts'], ['src/econ/**']).tier, 'high');
  assert.equal(tier(['src/econ/deep/pricing.ts'], ['src/econ/**']).tier, 'high');
  assert.equal(tier(['src/econ/pricing.ts'], ['src/econ/*.ts']).tier, 'high');
  assert.equal(tier(['src/econ/deep/pricing.ts'], ['src/econ/*.ts']).tier, 'medium');
  assert.equal(tier(['src/a1.ts'], ['src/a?.ts']).tier, 'high');
  assert.equal(tier(['src/a12.ts'], ['src/a?.ts']).tier, 'medium');
  assert.equal(tier(['x/y/legal.md'], ['legal.md']).tier, 'high');
  assert.match(tier(['src/econ/pricing.ts'], ['src/econ/**']).why.join(' '), /owner/i);
});

test('risk: an owner-listed path beats the docs rule', () => {
  assert.equal(tier(['docs/legal/terms.md'], ['docs/legal/**']).tier, 'high');
});

test('risk: paths are normalised (backslashes, ./, case, Cyrillic, spaces)', () => {
  assert.equal(tier(['.github\\workflows\\ci.yml']).tier, 'high');
  assert.equal(tier(['./.github/workflows/ci.yml']).tier, 'high');
  assert.equal(tier(['.GitHub/Workflows/CI.yml']).tier, 'high');
  assert.equal(tier(['.\\README.md']).tier, 'low');
  assert.equal(tier(['docs/мой файл.md']).tier, 'low');
  assert.equal(tier(['Документы/Платежи/a.ts'], ['документы/платежи/**']).tier, 'high');
  assert.equal(tier(['src/my dir/a b.ts']).tier, 'medium');
});

test('risk: a path that climbs out of the project is flagged high', () => {
  for (const p of ['../outside.md', 'docs/../../x.md', 'a/../..\\b.md']) {
    const r = tier([p]);
    assert.equal(r.tier, 'high', p);
    assert.match(r.why.join(' '), /outside|escape|\.\./i);
  }
});

test('risk: absolute, NUL and oversized paths are flagged high', () => {
  for (const p of ['C:\\Windows\\x.md', '/etc/passwd.md', 'a\0b.md', 'a/'.repeat(1000) + 'x.md']) assert.equal(tier([p]).tier, 'high', JSON.stringify(p).slice(0, 30));
});

test('risk: hostile humanPaths (empty, huge, non-string) are ignored and cannot hang', () => {
  const t0 = Date.now();
  const r = riskTier(['src/a.ts'], { humanPaths: ['', '   ', 'x'.repeat(5000), 5 as unknown as string, '**/**/**/**/**/**/**/**/b', '(((['] });
  assert.equal(r.tier, 'medium');
  assert.ok(Date.now() - t0 < 2000);
});

test('risk: why lists each reason once and stays short for many files', () => {
  const r = tier(Array.from({ length: 500 }, (_, i) => `.github/workflows/w${i}.yml`));
  assert.equal(r.tier, 'high');
  assert.ok(r.why.length <= 50);
});

test('globMatch: * stays inside a segment, ** crosses, ? is one char, trailing / means the directory', () => {
  assert.equal(globMatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/d/a.ts'), false);
  assert.equal(globMatch('src/**', 'src/d/e/a.ts'), true);
  assert.equal(globMatch('src/**/a.ts', 'src/a.ts'), true);
  assert.equal(globMatch('src/**/a.ts', 'src/d/e/a.ts'), true);
  assert.equal(globMatch('src/a?.ts', 'src/ab.ts'), true);
  assert.equal(globMatch('src/', 'src/d/a.ts'), true);
  assert.equal(globMatch('a.b', 'aXb'), false);
  assert.equal(globMatch('SRC/*.TS', 'src/a.ts'), true);
});
