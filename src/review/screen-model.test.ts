import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The review screen's data layer is DOM-free, so the hostile-data rules are checked in node. (Dynamic import: the file is plain web JS.)
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'review-model.js')).href) as Record<string, (...a: unknown[]) => unknown>;
const model = M['model'] as (raw: unknown) => { review: Record<string, unknown>; findings: Record<string, unknown>[]; checks: Record<string, unknown>[]; warnings: string[]; reasons: string[]; riskWhy: string[] };

const good = (o: Record<string, unknown> = {}) => ({ id: 'fdabc123', severity: 'important', file: 'src/a.ts', line: 2, title: 'Off-by-one', evidence: 'x', votes: { real: 2, notReal: 0 }, answer: 'open', hunk: { from: 1, at: 1, lines: ['a', 'b', 'c'] }, ...o });
const raw = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ review: { id: 'rvabc123', runId: 'rabc1', projectId: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), effort: 'standard', risk: 'medium', round: 1, state: 'open' }, findings, checks: [], warnings: [], reasons: [], riskWhy: [], ...extra });

test('model: hostile fields (objects, arrays, huge strings, wrong enums) become safe values and never throw', () => {
  const evil = { toString: 1, valueOf: 2, constructor: { prototype: 3 } };
  const L = 'Z'.repeat(100_000);
  const m = model(raw([
    good({ title: evil, file: evil, evidence: evil, classOfBug: [evil], severity: evil, answer: evil, reason: evil, votes: evil, hunk: evil, line: evil, id: evil }),
    good({ title: L, file: L, evidence: L, classOfBug: L, reason: L, hunk: { from: 1, at: 99, lines: Array.from({ length: 500 }, () => L) } }),
    good({ severity: '__proto__', answer: 'constructor', hunk: { from: -5, at: -1, lines: 'abc' } }),
    null, 7, 'x', [], { votes: { real: -3, notReal: Infinity } },
  ], { checks: [evil, { name: evil, ok: 'yes', tail: L }], warnings: [evil, L], reasons: [7, { a: 1 }], riskWhy: [null], review: { ...raw([]).review, state: evil, risk: 'constructor', effort: ['deep'], round: evil, humanApproval: evil, headSha: { x: 1 } } }));
  assert.equal(m.findings.length, 4, 'only objects are findings: null, numbers, strings and arrays are dropped');
  for (const f of m.findings) {
    for (const k of ['file', 'title', 'evidence', 'classOfBug', 'reason', 'id'] as const) assert.equal(typeof f[k], 'string', k);
    assert.ok((f['title'] as string).length <= 300 && (f['file'] as string).length <= 300 && (f['evidence'] as string).length <= 1500 && (f['classOfBug'] as string).length <= 160 && (f['reason'] as string).length <= 600);
    assert.ok(['security', 'important', 'nit', 'pre-existing'].includes(f['severity'] as string));
    assert.ok(['open', 'fixed', 'rejected', 'intentional', 'dismissed'].includes(f['answer'] as string));
    const v = f['votes'] as { real: number; notReal: number }; assert.ok(Number.isInteger(v.real) && v.real >= 0 && Number.isInteger(v.notReal) && v.notReal >= 0);
    assert.ok(Number.isInteger(f['line']) && (f['line'] as number) >= 0);
    const h = f['hunk'] as { from: number; at: number; lines: string[] } | null;
    if (h) { assert.ok(h.lines.length <= 9 && h.lines.every((l) => typeof l === 'string' && l.length <= 300)); assert.ok(h.at >= 0 && h.at < h.lines.length && h.from >= 1); }
  }
  assert.equal(m.findings[0]!['id'], '', 'an object id is not an id');
  assert.equal(m.findings[0]!['title'], 'Без названия');
  assert.equal(m.findings[2]!['severity'], 'nit', 'an unknown (prototype) severity is the harmless one');
  assert.equal(m.findings[2]!['hunk'], null);
  assert.equal(m.review['state'], 'open'); assert.equal(m.review['risk'], 'low'); assert.equal(m.review['effort'], 'standard'); assert.equal(m.review['round'], 1); assert.equal(m.review['headSha'], ''); assert.equal(m.review['approvedSha'], '');
  assert.equal(m.checks.length, 2);
  assert.ok(m.checks.every((c) => typeof c['name'] === 'string' && typeof c['ok'] === 'boolean' && (c['tail'] as string).length <= 4000));
  assert.ok(m.warnings.every((w) => typeof w === 'string' && w.length <= 400)); assert.deepEqual(m.reasons, []); assert.deepEqual(m.riskWhy, []);
});

test('model: garbage in the top level (null, string, array, no review) gives an empty model, never an exception', () => {
  for (const x of [null, undefined, 'str', 7, [], { review: 'x', findings: 'y', checks: 5 }]) {
    const m = model(x);
    assert.equal(m.review['id'], ''); assert.deepEqual(m.findings, []); assert.deepEqual(m.checks, []);
  }
});

test('counts: "2 важных, 1 мелочь, 3 старых проблемы", security first, closed findings are not counted, empty is empty', () => {
  const m = model(raw([good(), good(), good({ severity: 'nit' }), ...[1, 2, 3].map(() => good({ severity: 'pre-existing' })), good({ severity: 'security' }), good({ answer: 'rejected' })]));
  assert.equal(M['countsText']!(m), '1 по безопасности, 2 важных, 1 мелочь, 3 старые проблемы');
  assert.equal(M['closedCount']!(m), 1);
  assert.equal(M['countsText']!(model(raw([good()]))), '1 важная');
  assert.equal(M['countsText']!(model(raw([]))), '');
  assert.equal(M['cardText']!(m), 'Ревью: 3 важных, 1 мелочь');
  assert.equal(M['votesText']!({ votes: { real: 2, notReal: 0 } }), '2 из 2 проверяющих согласны');
  assert.equal(M['votesText']!({ votes: { real: 1, notReal: 0 } }), '1 из 1 проверяющего согласен');
});

test('stepper: red check closes the gate and skips the AI steps; each state marks its own step', () => {
  const s = (extra: Record<string, unknown>, state = 'open', fs: unknown[] = []) => M['stepStates']!(model(raw(fs, { ...extra, review: { ...raw([]).review, state } })));
  assert.deepEqual(s({ checks: [{ name: 'npm test', ok: false, tail: 'x' }] }), ['fail', 'skip', 'skip', 'skip', 'skip']);
  assert.deepEqual(s({}, 'checks'), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(s({}, 'hunting'), ['done', 'current', 'todo', 'todo', 'todo']);
  assert.deepEqual(s({}, 'verifying'), ['done', 'done', 'current', 'todo', 'todo']);
  assert.deepEqual(s({}, 'passed'), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(s({}, 'open', [good()]), ['done', 'done', 'done', 'done', 'current']);
  assert.deepEqual(s({}, 'open', [good({ severity: 'security' })]), ['done', 'done', 'done', 'fail', 'current']);
  assert.deepEqual(s({ reasons: ['no usable reviewer: x'], checks: [{ name: 'a', ok: true, tail: '' }] }), ['done', 'skip', 'skip', 'skip', 'skip']);
  assert.equal(M['nothingFound']!(model(raw([], { review: { ...raw([]).review, state: 'passed' } }))), true);
  assert.equal(M['nothingFound']!(model(raw([], { checks: [{ name: 'a', ok: false, tail: '' }] }))), false, 'a red check is not "nothing to fix"');
});

test('Russian words: known server reasons are translated, unknown ones are kept as text', () => {
  assert.equal(M['reasonRu']!('2 open important findings'), 'Открытых важных находок: 2');
  assert.equal(M['reasonRu']!('high-risk change: a human must approve commit abcdef1234'), 'Высокий риск: нужно ваше подтверждение коммита abcdef1234');
  assert.equal(M['reasonRu']!('Три круга ревью не сошлись — пересмотрите подход'), 'Три круга ревью не сошлись — пересмотрите подход');
  assert.equal(M['reasonRu']!('something new'), 'something new');
  assert.equal(M['reasonRu']!({ a: 1 }), '');
  assert.match(M['warnRu']!('only claude is usable: every reviewer runs on one vendor, so there is no cross-vendor diversity') as string, /^Работает только Claude/);
  assert.equal(M['riskWhyRu']!('dependency manifest: package.json (+2 more)'), 'Список зависимостей: package.json (ещё 2)');
  assert.equal(M['riskWhyRu']!('constructor: x'), 'constructor: x', 'a prototype key is not a label');
});

test('screen files: no innerHTML, no inline colours, route and links are wired, the stylesheet is linked', () => {
  const read = (...p: string[]) => readFileSync(join(here, '..', '..', 'web', ...p), 'utf8');
  for (const f of [['js', 'views', 'review.js'], ['js', 'review-model.js']] as string[][]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(read(...f)), f.join('/'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(read('css', 'review.css')), 'review.css uses tokens only');
  assert.ok(read('js', 'main.js').includes("import('./views/review.js')"));
  assert.match(read('index.html'), /css\/review\.css/);
  assert.match(read('js', 'views', 'chat.js'), /reviewCard/);
  assert.match(read('js', 'views', 'project.js'), /reviewLinks/);
  for (const t of ['Три круга ревью не сошлись — пересмотрите подход', 'Подтверждаю этот коммит', 'Исправить агентом', 'Не баг — причина…', 'Так задумано', 'Нечего исправлять', 'Повторяется — вынести в правило', 'Запустить ревью', 'ИИ-ревью не запускалось']) assert.ok((read('js', 'views', 'review.js') + read('js', 'review-model.js')).includes(t), t);
});
