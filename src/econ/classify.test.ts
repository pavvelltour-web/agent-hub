import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENT, classify } from './classify.ts';

const cls = (p: string): string => classify(p).cls;

test('classify: clear Russian and English requests get their class with enough confidence', () => {
  for (const [p, want] of [
    ['почини падающий тест', 'debug'], ['Fix the failing test in parser', 'debug'], ['найди причину ошибки при запуске', 'debug'],
    ['спланируй архитектуру модуля оплаты', 'plan'], ['Design the architecture for the sync service', 'plan'],
    ['переименуй функцию load в loadAll', 'mechanical'], ['rename the variable and fix the typo', 'mechanical'], ['отформатируй файл', 'mechanical'], ['run prettier on src', 'mechanical'],
    ['проверь PR', 'review'], ['review this pull request', 'review'], ['сделай ревью диффа', 'review'],
    ['кратко перескажи этот файл', 'summary'], ['summarize the changelog', 'summary'],
    ['реализуй экспорт истории в JSON', 'implement'], ['add a settings page', 'implement'],
    ['напиши ADR про выбор базы данных', 'critical_adr'], ['write an ADR: irreversible migration of the data format', 'critical_adr'],
  ] as const) {
    const r = classify(p);
    assert.equal(r.cls, want, `${p} → ${r.cls} (${r.why})`);
    assert.ok(r.confidence >= CONFIDENT, `${p}: confidence ${r.confidence}`);
    assert.ok(r.why.length > 0);
  }
});

test('classify: ambiguous, empty or hostile input stays below the confidence bar and never throws', () => {
  for (const p of ['посмотри на модуль оплаты', 'сделай хорошо', 'почини падающий тест и спланируй архитектуру', '', '   ', 'a'.repeat(200_000), '😀 ¯\_(ツ)_/¯']) {
    const r = classify(p);
    assert.ok(r.confidence < CONFIDENT, `${p.slice(0, 40)}: ${r.cls} ${r.confidence}`);
    assert.ok(['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary'].includes(r.cls), 'always a real class: the UI asks, the router never sees junk');
  }
  assert.equal(CONFIDENT, 0.6);
  assert.equal(cls(undefined as unknown as string), 'implement', 'a missing prompt is not a crash');
});

test('classify: the words that decided are named, in the prompt\'s own language', () => {
  assert.match(classify('почини падающий тест').why, /почини|падающ/);
  assert.match(classify('fix the failing test').why, /fix|failing/);
});

test('classify (review S4): a critical-decision word is never outvoted by debug words: the strictest type wins and the answer says why', () => {
  for (const p of ['Change the security boundary: fix failing crash in auth', 'необратимое решение: почини падающий тест с ошибкой', 'fix the bug, it touches the security boundary', 'граница безопасности: исправь ошибку в авторизации']) {
    const r = classify(p);
    assert.equal(r.cls, 'critical_adr', `${p} → ${r.cls} ${r.confidence}`);
    assert.ok(r.confidence >= CONFIDENT, `${p}: the UI must set it, not ask: ${r.confidence}`);
    assert.match(r.why, /(security boundary|необратим|граница безопасности)/i, 'names the word that raised it');
    assert.match(r.why, /строг|strict/i, 'says the type was raised to the strictest');
  }
  assert.equal(classify('fix the failing test with a crash').cls, 'debug', 'without a critical word it stays debug');
});
