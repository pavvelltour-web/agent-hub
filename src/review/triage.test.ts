import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLinesFromUnified, triage } from './triage.ts';
import type { VerifiedFinding } from './types.ts';

const vf = (o: Partial<VerifiedFinding> = {}): VerifiedFinding => ({
  lens: 'correctness', file: 'src/a.ts', line: 10, title: 'T', evidence: 'E', category: 'bug', votes: { real: 2, notReal: 0 }, ...o,
});
const ctx = (diff: string[], extra: { posted?: Set<string> } = {}) => ({
  diffLines: new Set(diff), maxNits: 5, posted: extra.posted ?? new Set<string>(),
  reviewId: 'rv1', round: 1, lineText: (f: string, l: number) => `text of ${f}:${l}`,
});

test('triage: a bug on a changed line is important and gets its identity filled', () => {
  const [f] = triage([vf()], ctx(['src/a.ts:10']));
  assert.ok(f);
  assert.equal(f.severity, 'important');
  assert.equal(f.reviewId, 'rv1');
  assert.equal(f.round, 1);
  assert.equal(f.answer, 'open');
  assert.match(f.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(f.id.length > 0);
});

test('triage: style, cleanup and diagnostic findings are dropped', () => {
  const out = triage([vf({ category: 'style' }), vf({ category: 'cleanup', line: 11 }), vf({ category: 'diagnostic', line: 12 })], ctx(['src/a.ts:10', 'src/a.ts:11', 'src/a.ts:12']));
  assert.deepEqual(out, []);
});

test('triage: a finding on an untouched line is pre-existing, never important', () => {
  const [f] = triage([vf({ line: 99 })], ctx(['src/a.ts:10']));
  assert.equal(f?.severity, 'pre-existing');
});

test('triage: a security finding on a changed line is security', () => {
  const [f] = triage([vf({ lens: 'security' })], ctx(['src/a.ts:10']));
  assert.equal(f?.severity, 'security');
});

test('triage: a security finding on a line the diff did not touch is still pre-existing', () => {
  const [f] = triage([vf({ lens: 'security', line: 99 })], ctx(['src/a.ts:10']));
  assert.equal(f?.severity, 'pre-existing');
});

test('triage: a security-lens style finding is still dropped', () => {
  assert.deepEqual(triage([vf({ lens: 'security', category: 'style' })], ctx(['src/a.ts:10'])), []);
});

test('triage: a weakly supported risk (1 real, 0 not real) becomes a nit; a strong one stays important', () => {
  const out = triage([
    vf({ category: 'risk', votes: { real: 1, notReal: 0 }, line: 1 }),
    vf({ category: 'risk', votes: { real: 2, notReal: 0 }, line: 2 }),
    vf({ category: 'risk', votes: { real: 2, notReal: 1 }, line: 3 }),
    vf({ category: 'bug', votes: { real: 1, notReal: 0 }, line: 4 }),
  ], ctx(['src/a.ts:1', 'src/a.ts:2', 'src/a.ts:3', 'src/a.ts:4']));
  const by = new Map(out.map((f) => [f.line, f.severity]));
  assert.equal(by.get(1), 'nit');
  assert.equal(by.get(2), 'important');
  assert.equal(by.get(3), 'important');
  assert.equal(by.get(4), 'important');
});

test('triage: a weak security-lens risk is security, not a nit', () => {
  const [f] = triage([vf({ lens: 'security', category: 'risk', votes: { real: 1, notReal: 0 } })], ctx(['src/a.ts:10']));
  assert.equal(f?.severity, 'security');
});

test('triage: nits are capped at five, strongest first', () => {
  const found = Array.from({ length: 8 }, (_, i) => vf({ category: 'risk', line: i + 1, title: `n${i + 1}`, votes: { real: 1, notReal: 0 } }));
  const out = triage(found, ctx(found.map((f) => `src/a.ts:${f.line}`)));
  assert.equal(out.filter((f) => f.severity === 'nit').length, 5);
  assert.deepEqual(out.map((f) => f.line), [1, 2, 3, 4, 5]);
});

test('triage: repeats already posted, or duplicated inside the batch, are dropped', () => {
  const first = triage([vf()], ctx(['src/a.ts:10']));
  const fp = first[0]!.fingerprint;
  assert.deepEqual(triage([vf()], ctx(['src/a.ts:10'], { posted: new Set([fp]) })), []);
  assert.equal(triage([vf(), vf()], ctx(['src/a.ts:10'])).length, 1);
});

test('triage: a fingerprint survives a line move (same line text, other number)', () => {
  const o = ctx(['src/a.ts:10', 'src/a.ts:20']);
  o.lineText = () => 'same text';
  assert.equal(triage([vf(), vf({ line: 20 })], o).length, 1);
});

test('triage: sorted security, important, nit, pre-existing', () => {
  const out = triage([
    vf({ line: 1, category: 'bug' }),
    vf({ line: 2, category: 'bug', title: 'old' }),
    vf({ line: 3, category: 'risk', votes: { real: 1, notReal: 0 } }),
    vf({ line: 4, lens: 'security' }),
  ], ctx(['src/a.ts:1', 'src/a.ts:3', 'src/a.ts:4']));
  assert.deepEqual(out.map((f) => f.severity), ['security', 'important', 'nit', 'pre-existing']);
});

test('triage: hostile input never throws (bad lines, empty file, huge strings, bad votes, throwing lineText)', () => {
  const huge = 'x'.repeat(200_000);
  const o = ctx([`src/a.ts:10`]);
  o.lineText = () => { throw new Error('boom'); };
  const bad = [
    vf({ line: 1.5 }), vf({ line: NaN }), vf({ line: -3 }), vf({ line: 0 }), vf({ line: Infinity }), vf({ line: '7' as unknown as number }),
    vf({ file: '' }), vf({ file: huge }), vf({ file: 5 as unknown as string }),
    vf({ category: 'weird' as unknown as 'bug' }),
    vf({ votes: null as unknown as { real: number; notReal: number } }),
    vf({ votes: { real: NaN, notReal: -1 } }),
    null as unknown as VerifiedFinding, undefined as unknown as VerifiedFinding,
    vf({ title: huge, evidence: huge, classOfBug: huge }),
  ];
  const out = triage(bad, o);
  // only the three findings with a valid file/line/category survive (bad votes count as zero); all of them are clipped
  assert.equal(out.length, 2);
  for (const f of out) { assert.ok(f.title.length <= 500); assert.ok(f.evidence.length <= 5000); assert.ok((f.classOfBug ?? '').length <= 500); }
});

test('triage: backslash and ./ file spellings match the diff set', () => {
  const [f] = triage([vf({ file: '.\\src\\a.ts' })], ctx(['src/a.ts:10']));
  assert.equal(f?.severity, 'important');
  assert.equal(f?.file, 'src/a.ts');
});

// ---------- unified diff parser ----------

test('diffLinesFromUnified: added lines get new-file numbers; context counts, removals do not', () => {
  const d = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -1,4 +1,5 @@', ' one', '-two', '+TWO', '+two-b', ' three', ' four',
    '@@ -20,2 +21,3 @@', ' x', '+y', ' z', '',
  ].join('\n');
  assert.deepEqual([...diffLinesFromUnified(d)].sort(), ['src/a.ts:2', 'src/a.ts:22', 'src/a.ts:3']);
});

test('diffLinesFromUnified: hunk header without counts, and a content line that looks like +++', () => {
  const d = ['--- a/f', '+++ b/f', '@@ -1 +1,2 @@', '+++ not a header', '+second'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(d)].sort(), ['f:1', 'f:2']);
});

test('diffLinesFromUnified: new file, deleted file and /dev/null', () => {
  const d = [
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+a', '+b',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b',
  ].join('\n');
  assert.deepEqual([...diffLinesFromUnified(d)].sort(), ['n.txt:1', 'n.txt:2']);
});

test('diffLinesFromUnified: renamed file keys on the new path; pure rename adds nothing', () => {
  const pure = ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts'].join('\n');
  assert.equal(diffLinesFromUnified(pure).size, 0);
  const edited = ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', '--- a/old.ts', '+++ b/new.ts', '@@ -1,2 +1,2 @@', ' k', '-a', '+b'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(edited)], ['new.ts:2']);
});

test('diffLinesFromUnified: binary files are skipped and do not leak into the next file', () => {
  const d = [
    'diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ',
    'diff --git a/t.txt b/t.txt', '--- a/t.txt', '+++ b/t.txt', '@@ -1 +1 @@', '-a', '+b',
  ].join('\n');
  assert.deepEqual([...diffLinesFromUnified(d)], ['t.txt:1']);
});

test('diffLinesFromUnified: "\\ No newline at end of file" is not a line', () => {
  const d = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(d)], ['f:2']);
});

test('diffLinesFromUnified: CRLF diff text', () => {
  const d = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '+c', ''].join('\r\n');
  assert.deepEqual([...diffLinesFromUnified(d)], ['f:2']);
});

test('diffLinesFromUnified: quoted Cyrillic path (octal escapes) and path with spaces', () => {
  const quoted = ['diff --git "a/\\321\\204\\320\\260\\320\\271\\320\\273.ts" "b/\\321\\204\\320\\260\\320\\271\\320\\273.ts"', '--- "a/\\321\\204\\320\\260\\320\\271\\320\\273.ts"', '+++ "b/\\321\\204\\320\\260\\320\\271\\320\\273.ts"', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(quoted)], ['файл.ts:1']);
  const spaced = ['--- a/my dir/my file.ts', '+++ b/my dir/my file.ts\t', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(spaced)], ['my dir/my file.ts:1']);
  const raw = ['--- a/папка/файл.ts', '+++ b/папка/файл.ts', '@@ -3 +3 @@', '-a', '+b'].join('\n');
  assert.deepEqual([...diffLinesFromUnified(raw)], ['папка/файл.ts:3']);
});

test('diffLinesFromUnified: garbage and truncated input never throws', () => {
  for (const s of ['', '\0\0\0', '@@ -x +y @@', '+++ b/f\n@@ -1 +1 @@\n+a', '@@ -1,999999999 +1,999999999 @@\n+a\n+b', 'diff --git', '+++ "b/unterminated']) {
    assert.doesNotThrow(() => diffLinesFromUnified(s));
  }
  assert.deepEqual([...diffLinesFromUnified('+++ b/f\n@@ -1 +1 @@\n+a')], ['f:1']);
});
