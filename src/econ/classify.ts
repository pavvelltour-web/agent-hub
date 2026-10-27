import type { TaskClass } from './router.ts';

/**
 * Task type from the text of the request: keyword rules, Russian and English, no model call (free, instant, explainable).
 * Every hit adds evidence for a class; evidence of a class combines as 1 - Π(1 - weight). Confidence = the winner's evidence, cut by half of the runner-up's
 * (two classes with strong evidence = ambiguous). Below CONFIDENT the UI asks the user instead of guessing; with no hit at all the answer is `implement`
 * at 0.2: a placeholder the user is asked to confirm, never a silent pick.
 */
export const CONFIDENT = 0.6;
export interface Classified { cls: TaskClass; confidence: number; why: string }

const END = '(?![\\p{L}\\p{N}])';
/** [class, weight, regex source]. Each source starts at a word start (added below); `\p{L}*` lets a stem take endings, END closes a whole word. */
const RULES: [TaskClass, number, string][] = [
  ['debug', 0.8, `fix(?:es|ed|ing)?${END}(?!\\s+(?:the\\s+)?(?:typos?|spelling|formatting|lint|indent))`],
  ['debug', 0.8, 'почин\\p{L}*'], ['debug', 0.6, 'исправ\\p{L}*'],
  ['debug', 0.7, 'ошибк\\p{L}*|ошибок|баг\\p{L}*|падающ\\p{L}*|упал\\p{L}*|падает|сломал\\p{L}*|не работает|зависа\\p{L}*|краш\\p{L}*|исключени\\p{L}*'],
  ['debug', 0.6, 'найди причин\\p{L}*|отлад\\p{L}*|воспроизв\\p{L}*'],
  ['debug', 0.7, `bugs?${END}|failing|fails${END}|failures?${END}|crash\\p{L}*|broken${END}|exceptions?${END}|regression\\p{L}*|traceback|stack ?trace|errors?${END}`],
  ['debug', 0.6, 'debug\\p{L}*|diagnos\\p{L}*|root cause'],

  ['plan', 0.8, 'спланир\\p{L}*|составь план|план работ|roadmap'], ['plan', 0.8, `plan${END}|planning${END}`],
  ['plan', 0.7, 'спроектир\\p{L}*'], ['plan', 0.5, 'архитектур\\p{L}*|стратеги\\p{L}*|design\\p{L}*|architecture|strategy'],

  ['critical_adr', 0.9, `adrs?${END}|архитектурн\\p{L}* решени\\p{L}*|architecture decision`],
  ['critical_adr', 0.7, 'необратим\\p{L}*|irreversible|критическ\\p{L}* решени\\p{L}*|security boundary|граница безопасности'],

  ['review', 0.6, 'ревью|review\\p{L}*|code review'], ['review', 0.5, 'проверь|проверить|проверка|check\\p{L}*|audit\\p{L}*|аудит\\p{L}*'],
  ['review', 0.7, `prs?${END}|pull request\\p{L}*|merge request\\p{L}*|пулл?-?реквест\\p{L}*|diff${END}|дифф\\p{L}*`],

  ['mechanical', 0.8, 'переимену\\p{L}*|rename\\p{L}*|отформатир\\p{L}*|reformat\\p{L}*|autoformat|prettier|lint\\p{L}*|опечат\\p{L}*|typos?|переставь|реформатир\\p{L}*'],
  ['mechanical', 0.6, 'удали неиспользуем\\p{L}*|remove unused|обнови версию|bump\\p{L}*|поправь текст|spelling'],

  ['summary', 0.8, 'перескаж\\p{L}*|summar\\p{L}*|tl;?dr|резюм\\p{L}*|суммир\\p{L}*'], ['summary', 0.5, 'кратко|brief\\p{L}*|объясни|explain\\p{L}*|опиши|describe'],

  ['implement', 0.8, 'реализуй\\p{L}*|implement\\p{L}*|разработай'],
  ['implement', 0.7, `добав\\p{L}*|add${END}|создай\\p{L}*|create${END}|build${END}|features?${END}|фич\\p{L}*|функциональност\\p{L}*`],
  ['implement', 0.5, `напиши|write${END}`],
].map(([c, w, src]) => [c, w, `(?<![\\p{L}\\p{N}])(?:${src as string})`] as [TaskClass, number, string]);
const COMPILED = RULES.map(([cls, w, src]) => [cls, w, new RegExp(src, 'giu')] as const);
const MAX_CHARS = 4000;

export function classify(prompt: string): Classified {
  const text = typeof prompt === 'string' ? prompt.slice(0, MAX_CHARS) : '';
  const ru = /[Ѐ-ӿ]/.test(text);
  const left = new Map<TaskClass, number>(), words = new Map<TaskClass, string[]>();
  for (const [cls, w, re] of COMPILED) {
    re.lastIndex = 0;
    const hit = text.match(re);
    if (!hit) continue;
    const seen = words.get(cls) ?? [];
    for (const x of new Set(hit.map((m) => m.toLowerCase()))) {     // every distinct word is evidence once; the same word repeated is not more
      if (seen.includes(x)) continue;
      seen.push(x); left.set(cls, (left.get(cls) ?? 1) * (1 - w));
    }
    words.set(cls, seen);
  }
  const scored = [...left].map(([cls, l]) => [cls, 1 - l] as const).sort((a, b) => b[1] - a[1]);
  const top = scored[0];
  if (!top) return { cls: 'implement', confidence: 0.2, why: ru ? 'опорных слов не нашлось' : 'no keyword matched' };
  const second = scored[1]?.[1] ?? 0;
  const found = [...new Set(words.get(top[0]))].slice(0, 4).join(', ');
  return { cls: top[0], confidence: Math.round(top[1] * (1 - second / 2) * 100) / 100, why: (ru ? 'по словам: ' : 'by words: ') + found };
}
