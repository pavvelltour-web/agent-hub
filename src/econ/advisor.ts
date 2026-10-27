import type { AgentId } from '../core/types.ts';
import type { Profile } from './econ.ts';
import { PRIORS, tagsFor, type Basis, type PriorSet } from './priors.ts';
import { agentOf, EFFORT, MODEL_ID, modelKey, rank, type EffortLevel, type ModelStats, type Option, type TaskClass } from './router.ts';

export type { TaskClass, ModelStats, Option, EffortLevel };
export interface Pick { agent: AgentId; model: string; effort: string }
export interface Choice extends Pick { rule: string; reason: string; /** the price behind this pick comes from the user's own prices.json */ overridden?: boolean; basis?: Basis[]; alt?: Pick & { why: string; overridden?: boolean }; options?: (Option & { chosen: boolean })[] }

/** Starting table (author's decision: Opus plans, Sonnet works, Haiku summarizes). Used for guard rails, the diagram and as the prior of the optimizer. */
export const ROUTING: Record<TaskClass, { model: string; effort: string; reason: string }> = {
  plan: { model: 'claude-opus-5-5', effort: 'high', reason: 'Планы и архитектура: ошибка здесь стоит дороже всей сессии, поэтому самая сильная модель.' },
  critical_adr: { model: 'claude-opus-5-5', effort: 'max', reason: 'Решения, которые трудно отменить (безопасность, формат данных): максимум рассуждения.' },
  implement: { model: 'claude-sonnet-5-5', effort: 'high', reason: 'Код по готовому плану: Sonnet с глубоким мышлением. Дешевле Opus и надёжнее быстрого режима: меньше повторных попыток.' },
  debug: { model: 'claude-sonnet-5-5', effort: 'high', reason: 'Поиск причины ошибки: нужно больше рассуждения, чем для обычного кода.' },
  review: { model: 'claude-opus-5-5', effort: 'medium', reason: 'Проверка чужих правок: сильная модель находит больше ошибок.' },
  mechanical: { model: 'claude-sonnet-5-5', effort: 'low', reason: 'Переименования, форматирование, тексты: думать глубоко не нужно.' },
  summary: { model: 'claude-haiku-5-5', effort: 'low', reason: 'Краткие пересказы и карточки передачи: самая дешёвая модель.' },
};

const GPT_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const EFFORT_RU: Record<EffortLevel, string> = { low: 'быстро', medium: 'обычно', high: 'глубоко', xhigh: 'очень глубоко', max: 'максимум' };
const FAMILY_RU: Record<Option['family'], string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', gpt: 'GPT' };
/** «Sonnet · глубоко»: how a pair is named in plain Russian. */
export const pairLabel = (o: { family: Option['family']; effort: EffortLevel }): string => `${FAMILY_RU[o.family]} · ${EFFORT_RU[o.effort]}`;

export interface LimitState { usedPercent: number | null; reached: boolean }
export interface AdviseIn {
  cls: TaskClass; securityBoundary?: boolean; failures?: number; limits?: Partial<Record<AgentId, LimitState>>; thresholdPercent?: number; codexModel?: string; implementedBy?: AgentId;
  stats?: ModelStats;            // what the user's own finished runs say about quality (per model and per model+effort pair)
  effortProfiles?: Record<string, Profile>;   // measured tokens per `agent:effort`; priced instead of the prior multiplier once there are >= 3 runs
  priceWeight?: number;          // 1 = default balance, <1 favours quality, >1 favours price
  tags?: string[];               // task tags: terminal, doc-qa, computer-use, long-prompt, routine-build
  expectedInputTokens?: number;  // above the surcharge threshold in the priors data this adds the long-prompt tag
  priors?: PriorSet;             // default: registry/model-priors.json
  explore?: number;              // share (0..0.3) of simple tasks used to try a less-measured model; 0 = never
  rand?: () => number;
}

const full = (l?: LimitState, th = 95): boolean => !!l && (l.reached || (l.usedPercent != null && l.usedPercent >= th));
const left = (l?: LimitState): number | null => (l?.usedPercent == null ? null : Math.max(0, 100 - l.usedPercent));
const EXPLORABLE = new Set<TaskClass>(['mechanical', 'summary', 'implement']);
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Advice with the rule that produced it. Guard rails first (they are not negotiable):
 *   security boundary → Opus; the same step failed twice → climb the ladder; an agent out of limit is excluded.
 * Then the optimizer (router.ts) picks the option closest to "top quality at low price" among what is left. A reviewer from the
 * other vendor gets a quality bonus; an agent whose limit is nearly spent gets a penalty when the other has clear room.
 * `alt` is the best option on the other vendor, so the user always sees both.
 */
export function advise(i: AdviseIn): Choice {
  const gpt = i.codexModel ?? 'gpt-6.1-sol';
  const th = i.thresholdPercent ?? 95;
  const base = ROUTING[i.cls];
  let forced: { model: string; effort: string; rule: string; reason: string } | undefined;
  if (i.securityBoundary && i.cls !== 'plan' && i.cls !== 'critical_adr') forced = { model: MODEL_ID.opus, effort: i.cls === 'review' ? 'high' : 'medium', rule: 'security-boundary', reason: 'Правка затрагивает безопасность: проверяет самая сильная модель.' };
  else if ((i.cls === 'implement' || i.cls === 'debug' || i.cls === 'mechanical') && (i.failures ?? 0) >= 2) {
    forced = (i.failures ?? 0) >= 3 ? { model: MODEL_ID.opus, effort: 'high', rule: 'ladder:opus', reason: 'Шаг не получается несколько раз: переходим на самую сильную модель и отдаём ей карточку передачи, а не весь чат.' }
      : { model: MODEL_ID.sonnet, effort: 'high', rule: 'ladder:sonnet-high', reason: 'Тот же шаг не прошёл дважды: добавляем рассуждения.' };
  }
  const claudeFull = full(i.limits?.claude, th), codexFull = full(i.limits?.codex, th);
  const cl = left(i.limits?.claude), cx = left(i.limits?.codex);
  const scarce = { claude: cl != null && cx != null && cl < 35 && cx - cl >= 25 && !codexFull, codex: cl != null && cx != null && cx < 35 && cl - cx >= 25 && !claudeFull };
  const priors = i.priors ?? PRIORS, tags = [...new Set([...(i.tags ?? []), ...tagsFor(i.expectedInputTokens, priors)])];
  const ranked = rank({ cls: i.cls, ...(i.stats ? { stats: i.stats } : {}), ...(i.effortProfiles ? { effortProfiles: i.effortProfiles } : {}), tags, priors, ...(i.priceWeight != null ? { priceWeight: i.priceWeight } : {}), codexModel: gpt, ...(i.implementedBy ? { implementedBy: i.implementedBy } : {}), scarce });
  const pickOf = (o: Option): { agent: AgentId; model: string; effort: string } => ({ agent: o.agent, model: o.model, effort: o.agent === 'codex' ? GPT_EFFORT[o.effort] ?? 'medium' : o.effort });
  // the map shows the best effort of each model (the chosen pair stands in for its model), so five dots are five models, not five efforts of one
  const withOpts = (c: Choice, chosen: Option | undefined): Choice => {
    const best: Option[] = [];
    for (const o of ranked) if (!best.some((b) => b.family === o.family)) best.push(chosen && chosen.family === o.family ? chosen : o);
    return { ...c, overridden: !!chosen?.overridden, options: best.slice(0, 5).map((o) => ({ ...o, chosen: !!chosen && o.key === chosen.key })) };
  };
  const altFor = (win: AgentId): Choice['alt'] => {
    const other = ranked.find((o) => o.agent !== win);
    if (!other) return undefined;
    const outOfLimit = win === 'claude' ? codexFull : claudeFull;
    return { ...pickOf(other), overridden: other.overridden, why: outOfLimit ? 'Тоже без запаса.' : win === 'claude' ? 'Подойдёт как второе мнение или когда у Claude закончится лимит.' : `Подойдёт, если нужен привычный стиль, но у него осталось ${cl != null ? Math.round(cl) + '%' : 'меньше'}.` };
  };

  if (claudeFull && codexFull) return withOpts({ agent: 'claude', model: forced?.model ?? base.model, effort: forced?.effort ?? base.effort, rule: 'limit:both', reason: 'Лимиты обоих агентов исчерпаны: подождите ближайшего сброса (он показан на странице «Модели»).', alt: { agent: 'codex', model: gpt, effort: 'medium', why: 'Тоже без запаса.' } }, undefined);

  // an agent out of limit is simply not an option
  const allowed = ranked.filter((o) => !(o.agent === 'claude' && claudeFull) && !(o.agent === 'codex' && codexFull));
  let win: Option | undefined = forced && !claudeFull ? ranked.find((o) => o.family !== 'gpt' && MODEL_ID[o.family] === forced?.model && o.effort === forced?.effort) ?? ranked.find((o) => o.family !== 'gpt' && MODEL_ID[o.family] === forced?.model) : allowed[0];
  if (forced && !claudeFull && win) {
    const c = { ...pickOf(win), model: forced.model, effort: forced.effort, rule: forced.rule, reason: forced.reason };
    const o = { ...win, effort: forced.effort as EffortLevel };
    return withOpts({ ...c, ...(o.basis.length ? { basis: o.basis } : {}), ...(altFor('claude') ? { alt: altFor('claude') } : {}) }, o);
  }
  if (!win) win = allowed[0];
  if (!win) return withOpts({ agent: 'claude', model: base.model, effort: base.effort, rule: `class:${i.cls}`, reason: base.reason }, undefined);

  // optional exploration: on simple tasks sometimes try the option we know least about, so the router learns instead of guessing forever
  let rule = '', reason = '';
  if ((i.explore ?? 0) > 0 && EXPLORABLE.has(i.cls) && !i.securityBoundary && (i.rand ?? Math.random)() < Math.min(0.3, i.explore ?? 0)) {
    const near = allowed.filter((o) => o.family !== win!.family && o.distance - win!.distance <= 0.03 && o.runs < win!.runs + 3).sort((a, b) => a.runs - b.runs)[0];
    if (near) { win = near; rule = 'explore'; reason = `Пробую эту модель на простой задаче: данных о ней мало, а выбор почти равнозначен. Так hub узнаёт, где можно сэкономить.`; }
  }
  const tableWin = win.agent === 'claude' && win.model === base.model && win.effort === base.effort;
  if (!rule) {
    if (claudeFull) { rule = 'limit:claude→codex'; reason = `У Claude лимит кончился, у Codex есть запас. ${base.reason}`; }
    else if (codexFull && i.cls === 'review' && i.implementedBy === 'claude') { rule = 'limit:codex'; reason = 'Codex без запаса, поэтому ревью делает Claude.'; }
    else if (i.cls === 'review' && i.implementedBy && win.bonus > 0) { rule = 'cross-review'; reason = `Код писал ${i.implementedBy === 'claude' ? 'Claude' : 'Codex'}, поэтому проверяет ${win.agent === 'codex' ? 'GPT через Codex' : 'Claude'}: другая модель замечает то, что своя пропускает.`; }
    else if (win.agent === 'codex' && scarce.claude) { rule = 'balance'; reason = `У Claude осталось ${Math.round(cl ?? 0)}%, у Codex ${Math.round(cx ?? 0)}%: даю работу Codex, чтобы не выжечь лимит Claude.`; }
    else if (tableWin) { rule = `class:${i.cls}`; reason = base.reason; }
    else { rule = 'optimizer'; reason = `${pairLabel(win)}: ближе всех к идеалу «хорошо и недорого», качество ≈ ${pct(win.quality)}, цена ≈ ${pct(win.price)} от самой дорогой модели. ${win.measured ? `Считаю по ${win.runs} вашим запускам.` : 'Пока по оценке автора: ваших запусков этого типа мало.'}`; }
  }
  const alt = altFor(win.agent);
  return withOpts({ ...pickOf(win), rule, reason, ...(win.basis.length ? { basis: win.basis } : {}), ...(alt ? { alt } : {}) }, win);
}

export { EFFORT, agentOf, modelKey };

/** Plain-language guide to every model the user can pick. Facts here are prices and roles chosen by the author, not benchmarks. */
export const MODEL_GUIDE: { agent: AgentId; id: string; name: string; use: string; note: string }[] = [
  { agent: 'claude', id: 'opus', name: 'Claude Opus 5.5', use: 'Планы, архитектура, ревью, трудные решения', note: 'Сильнее и примерно вдвое дороже Sonnet' },
  { agent: 'claude', id: 'sonnet', name: 'Claude Sonnet 5.5', use: 'Основная работа: код по готовому плану, правки, отладка', note: 'Лучшее соотношение цены и качества' },
  { agent: 'claude', id: 'haiku', name: 'Claude Haiku 5.5', use: 'Короткие пересказы, карточки передачи, простая рутина', note: 'Самая дешёвая' },
  { agent: 'claude', id: 'fable', name: 'Claude Fable 5.1', use: 'Самые трудные задачи, где остальные не справились', note: 'Самая дорогая: примерно в 5 раз дороже Sonnet' },
  { agent: 'codex', id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol (Codex)', use: 'Второе мнение, ревью кода, запасной вариант при лимите Claude', note: 'Свой лимит и своя подписка' },
  { agent: 'codex', id: 'gpt-6-astra', name: 'GPT 6 Astra (Codex)', use: 'Другая модель Codex из вашей подписки', note: 'Не оценивал' },
  { agent: 'codex', id: 'gpt-6-luna', name: 'GPT 6 Luna (Codex)', use: 'Другая модель Codex из вашей подписки', note: 'Не оценивал' },
];
