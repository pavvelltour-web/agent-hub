// The data layer of the guardrails line on the Today page (Phase 7.5). Plain JS, no DOM: the hostile-data rules are tested in node (src/run/breaker.test.ts).
// The answer of `GET /api/guardrails` is read by type (never `String(x)`); a trip kind outside the known set is dropped, its key must have the shape the server accepts
// for an acknowledgement, text is stripped of control, bidi and zero-width characters.
const KINDS = new Set(['run-cap', 'day-cap', 'same-failure', 'chain', 'repeated-stops']);
const EFFORT_RU = { quick: 'быстрое', standard: 'обычное', deep: 'глубокое' };
export const CAP_KEYS = ['runWeighted', 'runUsd', 'dayWeighted', 'dayUsd', 'sameFailureN', 'chainMax', 'stopsN'];
export const CAP_LABEL = { runWeighted: 'Один запуск: млн условных токенов', runUsd: 'Один запуск: $ по ценам API', dayWeighted: 'За сутки: млн условных токенов', dayUsd: 'За сутки: $ по ценам API', sameFailureN: 'Одна и та же ошибка подряд: раз', chainMax: 'Цепочка продолжений: запусков', stopsN: 'Остановок за час из-за контекста или лимита' };
export const ACK_KEY = /^(same-failure|repeated-stops):\d{1,9}$/;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const INVISIBLE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const plain = (s, n) => (typeof s === 'string' ? s.slice(0, n).replace(INVISIBLE, '') : '');

const capMap = (v) => Object.fromEntries(CAP_KEYS.map((k) => [k, fin(obj(v)[k]) ? obj(v)[k] : null]));

/** The server's answer, typed. `null` when it is not an object. */
export function guardModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw), rv = obj(r.review), u = obj(r.usage);
  return {
    enabled: r.enabled !== false,
    usage: { weighted: fin(u.dayWeighted) ? u.dayWeighted : 0, usd: fin(u.dayUsd) ? u.dayUsd : 0 },
    trips: (Array.isArray(r.trips) ? r.trips : []).slice(0, 6).map((t) => {
      const x = obj(t);
      return { kind: x.kind, key: typeof x.key === 'string' ? x.key.slice(0, 60) : '', ru: plain(x.ru, 320), slug: plain(x.slug, 80), ackable: x.ackable === true && typeof x.key === 'string' && ACK_KEY.test(x.key) };
    }).filter((t) => KINDS.has(t.kind) && t.ru),
    caps: capMap(r.caps), defaults: capMap(r.defaults), notes: (Array.isArray(r.notes) ? r.notes : []).slice(0, 5).map((x) => plain(x, 240)).filter(Boolean),
    ranges: Object.fromEntries(CAP_KEYS.map((k) => { const x = obj(obj(r.ranges)[k]); return [k, fin(x.min) && fin(x.max) ? { min: x.min, max: x.max } : null]; })),
    review: { tightened: rv.tightened === true, flag: rv.flagReviewer === true, why: plain(rv.why, 400), effort: Object.hasOwn(EFFORT_RU, rv.reviewEffort) ? rv.reviewEffort : 'standard' },
  };
}
export const effortText = (e) => EFFORT_RU[e] || EFFORT_RU.standard;
