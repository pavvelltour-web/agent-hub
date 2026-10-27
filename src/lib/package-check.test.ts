import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPackageList, localUserPathIn } from './package-check.ts';

const GOOD = [
  'package.json', 'README.md', 'bin/hub.js', 'scripts/install.ps1', 'scripts/security.mjs', 'src/cli/main.ts', 'src/lib/package-check.ts', 'src/review/prompts/hunt.md',
  'rules/base.md', 'modes/chat.json', 'modes/review.json', 'templates/web-saas/hub.json', 'templates/web-saas/gitignore', 'registry/starter.json', 'registry/entries/catalog.json',
  'src/adapters/fake-agent.mjs', 'src/core/mcp-test.ts', 'docs/STATUS.md', 'eval/review/off-by-one-loop/case.json',
];

test('package check: a clean list passes', () => {
  const r = checkPackageList(GOOD);
  assert.deepEqual(r.priv, []); assert.deepEqual(r.missing, []);
});

test('package check (S6): every private-looking name makes it fail, one by one', () => {
  const bad = [
    '.hub/security/report.json', 'graphify-out/graph.json', 'a/handoffs/card.md', 'a/cache/x.json', 'secrets/k', '.sandbox-secrets/k',
    '.env', '.env.local', 'sub/.env.production', 'auth.json', 'auth.json.bak', 'x/auth.json.old', '.credentials.json', '.credentials', 'credentials.json', 'cfg/credentials.json',
    '.npmrc', 'sub/.npmrc', 'id_rsa', 'id_rsa.pub', 'x/id_dsa', 'id_dsa.bak',
    'a.pem', 'a.key', 'a.pfx', 'a.p12', 'a.jks', 'a.sqlite', 'a.sqlite-wal', 'a.db', 'a.log',
    'src/core/x.test.ts', 'src/core/x.spec.ts', 'src/core/x.test.mjs', 'src/core/x.spec.js', 'src/core/x.test.cjs', 'src/core/x.test.js', 'web/x.spec.mts',
    'node_modules/a/b.js', 'refs-private/a', 'captures/a.png',
  ];
  for (const p of bad) assert.deepEqual(checkPackageList([...GOOD, p]).priv, [p], `${p} must be flagged`);
  for (const ok of ['src/core/credentials.ts', 'docs/cache-design.md', 'src/lib/idempotent.ts', 'web/js/views/secrets-note.js', 'src/history/store.ts'])
    assert.deepEqual(checkPackageList([...GOOD, ok]).priv, [], `${ok} is not private`);
});

test('package check (N5): fixtures and the checker source are not shipped; the install files are required', () => {
  for (const p of ['src/adapters/fixtures/claude-bash.unverified.jsonl', 'src/history/fixtures/claude-recorded.jsonl', 'src/cli/readonly-check.ps1.txt'])
    assert.deepEqual(checkPackageList([...GOOD, p]).shipped, [p], p);
  assert.deepEqual(checkPackageList(GOOD).shipped, []);
  for (const gone of ['rules/base.md', 'modes/review.json', 'templates/web-saas/gitignore', 'registry/starter.json', 'bin/hub.js', 'scripts/install.ps1', 'src/lib/package-check.ts', 'src/review/prompts/hunt.md'])
    assert.ok(checkPackageList(GOOD.filter((x) => x !== gone)).missing.includes(gone), `${gone} is required`);
  assert.ok(checkPackageList(GOOD.filter((x) => !x.startsWith('templates/'))).missing.includes('templates/'));
});

test('package check (N5): a file that holds the build machine user folder is found', () => {
  assert.ok(localUserPathIn('cd C:\\Users\\alice\\Desktop\\app', 'alice'));
  assert.ok(localUserPathIn('see c:/users/Alice/x', 'alice'));
  assert.ok(!localUserPathIn('cd C:\\Users\\<user>\\Desktop', 'alice'));
  assert.ok(!localUserPathIn('C:\\Users\\alice-evil\\x', 'alice'), 'only that exact folder name');
  assert.ok(!localUserPathIn('C:\\Users\\you\\project', 'alice'));
});
