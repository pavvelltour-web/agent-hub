import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../history/store.ts';
import { buildHuntPrompt } from './agents.ts';
import { addFindings, createReview } from './store.ts';
import { fingerprint } from './types.ts';
import type { RawFinding, Review } from './types.ts';
import { riskTier } from './risk.ts';
import { REVIEW_HEADINGS, appendRuleChange, humanPathsForChanges, humanPathsFromReviewMd, loadReviewMd, repeatedFindings, reviewTemplate, suggestRuleLine } from './reviewmd.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hub-reviewmd-'));
after(() => { rmSync(tmp, { recursive: true, force: true }); });
let n = 0;
const proj = (files: Record<string, string>, name = `p${++n}`): string => {
  const root = join(tmp, name); mkdirSync(root, { recursive: true });
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); }
  return root;
};

// ---- loadReviewMd -------------------------------------------------------------------------------------------------------------------

test('loadReviewMd: root file first, the NEAREST per-folder file after it; farther ones are not included', () => {
  const root = proj({ 'REVIEW.md': 'ROOT-RULES', 'src/REVIEW.md': 'SRC-RULES', 'src/web/REVIEW.md': 'WEB-RULES', 'src/web/ui/a.ts': 'x', 'src/api/b.ts': 'y' });
  const out = loadReviewMd(root, ['src/web/ui/a.ts']);
  assert.ok(out.indexOf('ROOT-RULES') >= 0 && out.indexOf('WEB-RULES') > out.indexOf('ROOT-RULES'));
  assert.ok(!out.includes('SRC-RULES'), 'the nearest wins: src/REVIEW.md is farther than src/web/REVIEW.md');
  const two = loadReviewMd(root, ['src/web/ui/a.ts', 'src/api/b.ts']);
  assert.ok(two.includes('WEB-RULES') && two.includes('SRC-RULES'), 'another changed path has its own nearest file');
});

test('loadReviewMd: each file once, root only when no folder file applies, missing root is fine', () => {
  const root = proj({ 'REVIEW.md': 'ROOT-RULES', 'src/REVIEW.md': 'SRC-RULES' });
  const out = loadReviewMd(root, ['src/a.ts', 'src/b.ts', 'src\\c.ts']);
  assert.equal(out.split('SRC-RULES').length - 1, 1);
  assert.equal(out.split('ROOT-RULES').length - 1, 1);
  assert.ok(!loadReviewMd(root, ['docs/x.md']).includes('SRC-RULES'));
  assert.equal(loadReviewMd(proj({}), ['a.ts']), '');
  assert.ok(loadReviewMd(proj({ 'REVIEW.md': 'ONLY-ROOT' }), []).includes('ONLY-ROOT'));
});

test('loadReviewMd: traversal, absolute and drive paths are ignored', () => {
  const outer = proj({ 'REVIEW.md': 'OUTSIDE-SECRET-RULES', 'x.ts': '' }, 'outer');
  const root = proj({ 'REVIEW.md': 'ROOT-RULES' });
  mkdirSync(join(root, 'sub'), { recursive: true });
  const bad = ['../outer/x.ts', 'sub/../../outer/x.ts', outer.replace(/\\/g, '/') + '/x.ts', outer + '\\x.ts', '/etc/x', 'C:\\Windows\\x', '\\\\srv\\share\\x', 'a\0b.ts'];
  const out = loadReviewMd(root, bad);
  assert.ok(out.includes('ROOT-RULES') && !out.includes('OUTSIDE-SECRET-RULES'));
});

test('loadReviewMd: a junction that points outside the project is not followed', (t) => {
  const outer = proj({ 'REVIEW.md': 'OUTSIDE-RULES', 'a.ts': '' }, 'outer-j');
  const root = proj({ 'REVIEW.md': 'ROOT-RULES' });
  try { symlinkSync(outer, join(root, 'link'), 'junction'); } catch { t.skip('cannot create a junction here'); return; }
  const out = loadReviewMd(root, ['link/a.ts']);
  assert.ok(out.includes('ROOT-RULES') && !out.includes('OUTSIDE-RULES'));
});

test('loadReviewMd: Cyrillic and space in the project path work', () => {
  const root = proj({ 'REVIEW.md': 'КОРЕНЬ', 'Моя папка/REVIEW.md': 'ПАПКА', 'Моя папка/файл один.ts': '' }, 'Мой проект с пробелом');
  const out = loadReviewMd(root, ['Моя папка/файл один.ts']);
  assert.ok(out.includes('КОРЕНЬ') && out.includes('ПАПКА') && out.indexOf('ПАПКА') > out.indexOf('КОРЕНЬ'));
});

test('loadReviewMd: total size is capped with a marker and the cap is not exceeded', () => {
  const root = proj({ 'REVIEW.md': 'R'.repeat(30_000), 'a/REVIEW.md': 'A'.repeat(30_000), 'a/x.ts': '' });
  const out = loadReviewMd(root, ['a/x.ts']);
  assert.ok(out.length <= 40 * 1024 + 200, String(out.length));
  assert.match(out, /truncated/);
  assert.ok(out.startsWith('R'), 'the root file stays first');
});

test('loadReviewMd: secrets inside REVIEW.md are redacted', () => {
  const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const root = proj({ 'REVIEW.md': `use ${key} here\npassword = hunter2hunter2`, 'src/REVIEW.md': `token ${key}`, 'src/a.ts': '' });
  const out = loadReviewMd(root, ['src/a.ts']);
  assert.ok(!out.includes(key) && !out.includes('hunter2hunter2'));
  assert.match(out, /REDACTED/);
});

// ---- repeated bug classes -----------------------------------------------------------------------------------------------------------

const mkReview = (over: Partial<Omit<Review, 'id'>> = {}): Omit<Review, 'id'> => ({ runId: 'r1', projectId: 1, baseSha: 'aaa', headSha: 'bbb', effort: 'standard', risk: 'medium', round: 1, state: 'open', ...over });
const rawF = (i: number, cls: string): RawFinding => ({ lens: 'correctness', file: `src/f${i}.ts`, line: 1, title: `T${i}${cls}`, evidence: 'e', ...(cls ? { classOfBug: cls } : {}), category: 'bug' });
const put = (db: ReturnType<typeof openDb>, reviewId: string, items: [number, string][]): void => {
  addFindings(db, reviewId, 1, items.map(([i, cls]) => { const r = rawF(i, cls); return { ...r, severity: 'important' as const, fingerprint: fingerprint(r, `l${i}`), votes: { real: 2, notReal: 0 } }; }));
};

test('repeatedFindings: a class seen 3 times across reviews is offered, 2 times is not, other projects and empty classes are ignored', () => {
  const db = openDb(':memory:');
  const a = createReview(db, mkReview()), b = createReview(db, mkReview({ runId: 'r2' })), other = createReview(db, mkReview({ runId: 'r3', projectId: 2 }));
  put(db, a.id, [[1, 'null-deref'], [2, 'null-deref'], [3, 'off-by-one'], [4, 'off-by-one'], [5, '']]);
  put(db, b.id, [[6, 'null-deref'], [7, 'off-by-one'], [8, '']]);
  put(db, other.id, [[9, 'race'], [10, 'race'], [11, 'race'], [12, 'null-deref']]);
  assert.deepEqual(repeatedFindings(db, 1), [{ classOfBug: 'null-deref', count: 3 }, { classOfBug: 'off-by-one', count: 3 }]);
  assert.deepEqual(repeatedFindings(db, 1, 4), []);
  assert.deepEqual(repeatedFindings(db, 2), [{ classOfBug: 'race', count: 3 }]);
  assert.deepEqual(repeatedFindings(db, 99), []);
});

test('repeatedFindings: most frequent first; letter case does not split a class', () => {
  const db = openDb(':memory:');
  const a = createReview(db, mkReview());
  put(db, a.id, [[1, 'Race'], [2, 'race'], [3, 'RACE'], [4, 'race'], [5, 'leak'], [6, 'leak'], [7, 'leak']]);
  const r = repeatedFindings(db, 1);
  assert.deepEqual(r.map((x) => x.count), [4, 3]);
  assert.equal(r[0]!.classOfBug.toLowerCase(), 'race');
});

test('suggestRuleLine: one plain English line (the agent reads it), class quoted as data, capped, no newlines or backticks', () => {
  const line = suggestRuleLine('null-deref');
  assert.match(line, /^Treat as broken: /); assert.ok(!/[А-Яа-я]/.test(line)); assert.ok(line.includes('null-deref')); assert.ok(!line.includes('\n'));
  const evil = suggestRuleLine('x`\n## Заголовок\n- [ссылка](http://e.x) <b>' + 'я'.repeat(400));
  assert.ok(!/[`\r\n<>]/.test(evil), evil);
  assert.ok(!evil.includes('](') && !/^#/.test(evil));
  assert.ok(evil.length < 300, String(evil.length));
  assert.ok(!evil.includes('я'.repeat(121)));
});

// ---- template, parsing, append -------------------------------------------------------------------------------------------------------

test('English headings are read, and so are the Russian ones of REVIEW.md files written by earlier versions; a new rule goes under the heading the file already uses', () => {
  const en = '# REVIEW.md\n\n## Paths that need a human\n- `src/pay/**`\n- billing.ts\n\n## Do not check\n- dist/**\n';
  const ru = '# REVIEW.md\n\n## Пути, где нужен человек\n- `src/pay/**`\n- billing.ts\n\n## Не проверять\n- dist/**\n';
  assert.deepEqual(humanPathsFromReviewMd(en), ['src/pay/**', 'billing.ts']);
  assert.deepEqual(humanPathsFromReviewMd(ru), ['src/pay/**', 'billing.ts']);
  const root = mkdtempSync(join(tmpdir(), 'hub-rv-head-'));
  try {
    writeFileSync(join(root, 'REVIEW.md'), ru);
    const a = appendRuleChange(root, 'Check permissions').after;
    assert.ok(a.replace(/\r/g, '').includes('## What counts as broken here\n- Check permissions'), 'a file with Russian headings but no "broken" section gets the English one');
    writeFileSync(join(root, 'REVIEW.md'), '# REVIEW.md\n\n## Что здесь считается поломкой\n- old\n');
    const b = appendRuleChange(root, 'Check permissions').after;
    assert.ok(/## Что здесь считается поломкой\n- old\n- Check permissions/.test(b.replace(/\r/g, '')), 'appended under the Russian heading the file has');
    writeFileSync(join(root, 'REVIEW.md'), '# REVIEW.md\n');
    assert.ok(/## What counts as broken here\n- Check permissions/.test(appendRuleChange(root, 'Check permissions').after.replace(/\r/g, '')), 'a file with no section gets the English heading');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the reviewer prompt tells the hunter to flag AGENTS.md lines that contradict the code', () => {
  const p = buildHuntPrompt({ lens: 'correctness', diff: 'diff --git a b', agentsMd: 'RULES', reviewMd: 'REVIEWMD-TEXT' });
  assert.match(p, /flag every line of AGENTS\.md that contradicts the code/);
  assert.ok(p.includes('REVIEWMD-TEXT'));
});

test('the headings are the five required ones, in order, in every template', () => {
  assert.deepEqual([...REVIEW_HEADINGS], ['What counts as broken here', 'Do not check', 'Paths that need a human', 'Nit limit: 5', 'Evidence: file and line']);
  for (const type of ['web-saas', 'mobile-app', 'automation', 'design-study']) {
    const t = reviewTemplate(type)!;
    assert.ok(t, type);
    const found = [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(found, [...REVIEW_HEADINGS], type);
  }
  assert.equal(reviewTemplate('nope'), null);
  assert.equal(reviewTemplate('../web-saas'), null);
  assert.notEqual(reviewTemplate('web-saas'), reviewTemplate('mobile-app'));
});

test('humanPathsForChanges: the root list plus the nearest folder REVIEW.md lists, scoped to their folder', () => {
  const H = '## Пути, где нужен человек\n';
  const root = proj({ 'REVIEW.md': H + '- src/auth/**\n', 'src/pay/REVIEW.md': H + '- `*.ts`\n- api/**\n', 'src/pay/far/REVIEW.md': H + '- deep.ts\n', 'lib/REVIEW.md': H + '- x.ts\n' });
  const got = humanPathsForChanges(root, ['src/pay/charge.ts']);
  assert.deepEqual(got, ['src/auth/**', 'src/pay/**/*.ts', 'src/pay/api/**']);
  assert.ok(riskTier(['src/pay/sub/x.ts'], { humanPaths: got }).tier === 'high' && riskTier(['src/other/x.ts'], { humanPaths: got }).tier === 'medium');
  // stricter (repair C, F11): a child folder's own REVIEW.md no longer hides its parents' lists
  assert.deepEqual(humanPathsForChanges(root, ['src/pay/far/a.ts']), ['src/auth/**', 'src/pay/**/*.ts', 'src/pay/api/**', 'src/pay/far/**/deep.ts'], 'every ancestor folder file counts');
  assert.equal(riskTier(['src/pay/far/a.ts'], { humanPaths: humanPathsForChanges(root, ['src/pay/far/a.ts']) }).tier, 'high', 'the parent list (*.ts under src/pay) covers a file under the child folder');
  assert.deepEqual(humanPathsForChanges(root, ['../x.ts', 'C:/abs.ts']), ['src/auth/**'], 'hostile paths read no folder file');
});

test('humanPathsFromReviewMd: bullets under the heading become globs; junk is ignored', () => {
  const text = [
    '# REVIEW.md', '## Что здесь считается поломкой', '- not/this/one', '', '## Пути, где нужен человек', 'Пишите пути списком: `a/**`.',
    '- src/auth/**', '* `migrations/**`', '-   ', '- ../escape/**', '- /abs/path', '- C:\\win\\x', '- это просто длинное предложение про то что нужно думать головой',
    '- ' + 'x'.repeat(300), '-', '- Моя папка/**', '1. numbered', '', '## Лимит мелочей: 5', '- after/heading',
  ].join('\n');
  assert.deepEqual(humanPathsFromReviewMd(text), ['src/auth/**', 'migrations/**', 'Моя папка/**']);
  assert.deepEqual(humanPathsFromReviewMd(''), []);
  assert.deepEqual(humanPathsFromReviewMd('## Другое\n- a/**'), []);
  assert.deepEqual(humanPathsFromReviewMd(reviewTemplate('web-saas') as string), [], 'a fresh template lists nothing');
});

test('appendRuleChange: adds a bullet under "What counts as broken here" and nowhere else; refuses bad lines', () => {
  const root = proj({ 'REVIEW.md': reviewTemplate('web-saas') as string });
  const c1 = appendRuleChange(root, 'Не принимать запросы без проверки прав');
  assert.equal(c1.action, 'update');
  const sections = c1.after.split(/^## /m);
  const sec = sections.find((s) => s.startsWith('What counts as broken here'))!;
  assert.ok(sec.includes('- Не принимать запросы без проверки прав'));
  assert.equal(c1.after.split('Не принимать запросы').length - 1, 1);
  assert.ok(c1.after.indexOf('- Не принимать') < c1.after.indexOf('## Do not check'));
  assert.ok(c1.after.startsWith(c1.before!.trimEnd()) || c1.after.length > c1.before!.length);
  writeFileSync(join(root, 'REVIEW.md'), c1.after);
  const c2 = appendRuleChange(root, 'Вторая строка');
  assert.ok(c2.after.indexOf('- Не принимать') < c2.after.indexOf('- Вторая строка'));
  assert.throws(() => appendRuleChange(root, 'Не принимать запросы без проверки прав'), /already/);
  for (const bad of ['', '   ', 'a\nb', 'a\rb', 'x'.repeat(301), 'a\0b']) assert.throws(() => appendRuleChange(root, bad), /line/, JSON.stringify(bad).slice(0, 20));
  assert.throws(() => appendRuleChange(proj({}), 'x'), /REVIEW\.md/);
  assert.deepEqual(readdirSync(root), ['REVIEW.md']);
  assert.equal(readFileSync(join(root, 'REVIEW.md'), 'utf8'), c1.after, 'planning never writes');
});

test('appendRuleChange: secrets are redacted, a missing heading is added at the end', () => {
  const root = proj({ 'REVIEW.md': '# REVIEW.md\n\nсвои заметки\n' });
  const c = appendRuleChange(root, 'ключ sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2' + ' нельзя');
  assert.ok(!c.after.includes('a1B2c3D4e5F6') && /## What counts as broken here\n- ключ/.test(c.after.replace(/\r/g, '')));
});
