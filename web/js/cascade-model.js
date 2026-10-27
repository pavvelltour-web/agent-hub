// Cascade steps model: turns the untrusted JSON of GET /api/runs/:id/cascade (model output and verify output are inside it) into plain, typed values and
// Russian words. No DOM here (unit-tested in node). Strings are read by type: an object where a string is expected becomes ''.
import { pick, str } from './review-model.js';

const RUN = /^r[0-9a-z]{2,40}$/;
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export const ROLE_RU = { executor: 'пишет', repair: 'дорабатывает по выводу проверки', 'stuck-review': 'разбирает, почему не выходит', fixer: 'правит' };
export const STATUS_RU = { running: ['идёт', 'info'], solved: ['проверка прошла', 'ok'], stopped: ['остановлено', 'warn'] };
export const VERIFY_RU = { passed: ['проверка прошла', 'ok'], failed: ['проверка красная', 'warn'], blocked: ['заблокировано', 'err'], hub: ['не проверено: ошибка hub', 'warn'], none: ['без проверки', 'line'] };

/** "Sonnet", "Opus", else a short plain name: never more than 24 safe characters of a model field. */
export const modelName = (m) => { const s = str(m, 80); return /opus/i.test(s) ? 'Opus' : /sonnet/i.test(s) ? 'Sonnet' : /haiku/i.test(s) ? 'Haiku' : /fable/i.test(s) ? 'Fable' : /gpt/i.test(s) ? 'GPT' : s.replace(/[^\w.-]/g, '').slice(0, 24) || 'агент'; };

/** The whole answer as safe values; `null` when it is not a cascade. Never throws. */
export function cascadeModel(raw) {
  const c = obj(obj(raw).cascade);
  if (!pick(STATUS_RU, c.status)) return null;
  const rungs = arr(c.rungs, 8).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r0) => {
    const r = obj(r0), role = r.role === 'stuck-review' || r.role === 'fixer' ? r.role : 'executor', repair = r.repair === true && role === 'executor';
    const blocked = str(r.blocked, 400);
    const verify = blocked ? (r.hubSide === true ? 'hub' : 'blocked') : role === 'stuck-review' ? 'none' : r.verifyPassed === true ? 'passed' : 'failed';
    return { runId: typeof r.runId === 'string' && RUN.test(r.runId) ? r.runId : '', role, repair, who: `${modelName(r.model)} ${ROLE_RU[repair ? 'repair' : role]}`, verify, blocked, note: str(r.note, 300), tail: str(r.tail, 4000) };
  });
  return { id: typeof c.id === 'string' && RUN.test(c.id) ? c.id : '', status: c.status, reason: str(c.reason, 400), card: str(c.card, 400), verify: arr(c.verify, 40).map((a) => str(a, 200)), rungs };
}

/** «Sonnet пишет → Opus разбирает → Opus правит»: the main steps in order (a repair by the same executor is not a new step). */
export function stepsLine(m) {
  const verb = { executor: 'пишет', 'stuck-review': 'разбирает', fixer: 'правит' };
  return m.rungs.filter((r) => !r.repair).map((r) => `${r.who.split(' ')[0]} ${verb[r.role]}`).join(' → ');
}
