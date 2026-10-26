import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeName, isSecretPath, norm, pathKey, safeJoin } from './paths.ts';
import { redact } from './redact.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { readJsonl } from './jsonl.ts';

test('norm unifies Windows path spellings', () => {
  assert.equal(norm('\\\\?\\C:\\Users\\user\\Desktop\\'), 'c:/Users/user/Desktop');
  assert.equal(pathKey('C:/Users/User/Desktop'), pathKey('c:\\users\\user\\desktop'));
});
test('safeJoin rejects traversal, absolute parts and NUL', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-'));
  assert.ok(safeJoin(root, 'a', 'b.txt').startsWith(root));
  assert.throws(() => safeJoin(root, '..', 'x'));
  assert.throws(() => safeJoin(root, 'a/../../x'));
  assert.throws(() => safeJoin(root, 'C:\\Windows'));
  assert.throws(() => safeJoin(root, 'a\0b'));
});
test('isSecretPath blocks credential files', () => {
  for (const p of ['C:/Users/u/.codex/auth.json', '/h/.claude/.credentials.json', 'x/secrets/a', '.env', 'a/.env.local']) assert.ok(isSecretPath(p), p);
  for (const p of ['docs/PLAN.md', 'src/secretsanta.ts']) assert.ok(!isSecretPath(p), p);
});
test('isSafeName allows task names, rejects shell/branch tricks', () => {
  for (const s of ['T016', 'hooks-compiler', 'a.b_c']) assert.ok(isSafeName(s));
  for (const s of ['', '-rf', 'a b', 'a;rm', 'a..b', '.hidden', 'x'.repeat(80), 'a/b']) assert.ok(!isSafeName(s), s);
});
test('redact removes seeded fake secrets, keeps normal text', () => {
  const fake = [
    'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'AKIAABCDEFGHIJKLMNOP',
    'Bearer abcdefghijklmnopqrstuvwxyz0123456789', 'password=hunter2hunter2', 'postgres://admin:s3cretpass@db.local/x',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ];
  for (const s of fake) { const r = redact(`before ${s} after`); assert.ok(r.includes('[REDACTED'), s); assert.ok(!r.includes(s.slice(-12)), s); }
  assert.equal(redact('привет, run npm test --watch'), 'привет, run npm test --watch');
});
test('parseFrontmatter reads plain and folded values', () => {
  const t = '---\nname: ponytail\ndescription: >\n  Forces the laziest\n  solution.\nlicense: MIT\n---\nbody';
  assert.deepEqual(parseFrontmatter(t), { name: 'ponytail', description: 'Forces the laziest solution.', license: 'MIT' });
});
test('readJsonl streams from offset, skips bad lines, ignores partial tail', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hub-')), 'a.jsonl');
  const big = 'x'.repeat(2_500_000);
  writeFileSync(f, `{"a":1}\nnot json\n{"big":"${big}"}\n{"a":3}\n{"partial":`);
  const all: { obj: any; endByte: number }[] = [];
  for await (const l of readJsonl(f)) all.push(l as any);
  assert.equal(all.length, 3);
  assert.equal(all[1]?.obj.big.length, 2_500_000);
  const rest: any[] = [];
  for await (const l of readJsonl(f, all[1]!.endByte)) rest.push(l.obj);
  assert.deepEqual(rest, [{ a: 3 }]);
});

test('cleanTitle: markdown markers, tags and boilerplate are dropped; empty input gives null', async () => {
  const { cleanTitle } = await import('./title.ts');
  assert.equal(cleanTitle('# Plan the **auth** flow'), 'Plan the auth flow');
  assert.equal(cleanTitle('Files mentioned by the user: <x> fix the bug'), 'fix the bug');
  assert.equal(cleanTitle('<system-reminder>ignore me</system-reminder> Real question'), 'Real question');
  assert.equal(cleanTitle('   '), null); assert.equal(cleanTitle(null), null);
  assert.equal(cleanTitle('x'.repeat(200))?.length, 90);
});

test('cleanTitle: a title that starts with an attached-file list falls through to the real question', async () => {
  const { cleanTitle } = await import('./title.ts');
  assert.equal(cleanTitle('# Files mentioned by the user:\n\n## Review.pdf: C:/Users/user/Downloads/x.pdf\n\nсделай разбор файла'), 'сделай разбор файла');
  assert.equal(cleanTitle('## a.pdf: C:/x/a.pdf'), null);
});
