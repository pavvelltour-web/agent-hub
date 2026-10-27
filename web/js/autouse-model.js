// The data layer of the «use the leftover limit» block and the Today card (Phase 7.4). Plain JS, no DOM: the hostile-data rules are tested in node
// (src/run/scheduler.test.ts). The answer of `GET /api/autouse` is read by type (never `String(x)`); the sentence for a kind comes from THIS file's own table
// (an unknown kind is dropped), numbers must be finite, text is stripped of control, bidi and zero-width characters.
const KIND_RU = { 'review-existing': 'прогнать ревью старого кода', 'missing-tests': 'дописать недостающие тесты в отдельной ветке' };
const AGENTS = { claude: 'Claude', codex: 'Codex' };
const STATUS = { approved: ['ждёт условий', 'info'], started: ['идёт', 'ok'], finished: ['готово', 'ok'], stopped: ['остановлено: мало лимита', 'warn'], expired: ['просрочено', 'line'], cancelled: ['отменено', 'line'], 'failed-to-start': ['не запустилось', 'err'] };
export const WORD_ID = /^au[0-9a-f]{8}$/;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const INVISIBLE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const plain = (s, n) => (typeof s === 'string' ? s.slice(0, n).replace(INVISIBLE, '') : '');

/** The server's answer, typed. `null` when it is not an object. */
export function autoModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw), s = obj(r.settings);
  const sc = obj(r.scheduler);
  return {
    scheduler: { state: ['own', 'free', 'other'].includes(sc.state) ? sc.state : 'free', silent: sc.silent === true },
    settings: { minLeftPct: fin(s.minLeftPct) ? s.minLeftPct : 20, marginPct: fin(s.marginPct) ? s.marginPct : 10, maxHours: fin(s.maxHoursToReset) ? s.maxHoursToReset : 24, approvalHours: fin(s.approvalHours) ? s.approvalHours : 48, loop: plain(s.loop, 80) },
    projects: (Array.isArray(r.projects) ? r.projects : []).slice(0, 30).map((p) => {
      const x = obj(p);
      return {
        id: Number.isSafeInteger(x.projectId) ? x.projectId : 0, slug: plain(x.slug, 80), enabled: x.enabled === true, confirmWord: plain(x.confirmWord, 120),
        suggestions: (Array.isArray(x.suggestions) ? x.suggestions : []).slice(0, 8).map((q) => {
          const y = obj(q);
          return { kind: y.kind, agent: y.agent, pct: fin(y.expectedPct) ? y.expectedPct : 0, left: fin(y.leftPct) ? y.leftPct : 0, hours: fin(y.hoursToReset) ? y.hoursToReset : 0, writes: y.writes === 'branch' ? 'branch' : 'none' };
        }).filter((y) => Object.hasOwn(KIND_RU, y.kind) && Object.hasOwn(AGENTS, y.agent) && y.pct > 0),
        blocked: (Array.isArray(x.blocked) ? x.blocked : []).slice(0, 4).map((b) => ({ agent: Object.hasOwn(AGENTS, obj(b).agent) ? obj(b).agent : '', why: plain(obj(b).why, 200) })).filter((b) => b.agent && b.why),
        items: (Array.isArray(x.items) ? x.items : []).slice(0, 12).map((i) => {
          const y = obj(i);
          return { id: typeof y.id === 'string' && WORD_ID.test(y.id) ? y.id : '', kind: y.kind, agent: y.agent, pct: fin(y.expectedPct) ? y.expectedPct : 0, status: Object.hasOwn(STATUS, y.status) ? y.status : 'cancelled', note: plain(y.note, 200), runId: typeof y.runId === 'string' && /^r[0-9a-z]{2,40}$/.test(y.runId) ? y.runId : '' };
        }).filter((i) => i.id && Object.hasOwn(KIND_RU, i.kind) && Object.hasOwn(AGENTS, i.agent)),
      };
    }).filter((p) => p.id > 0),
  };
}

export const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} мин` : `${Math.round(h)} ч`);
export const kindText = (k) => KIND_RU[k] || '';
export const agentText = (a) => AGENTS[a] || '';
export const statusText = (s) => STATUS[s] || STATUS.cancelled;
/** «До сброса Codex 9 ч, осталось 40 %: можно прогнать ревью старого кода». */
export const suggestionLine = (s) => `До сброса ${agentText(s.agent)} ${hoursText(s.hours)}, осталось ${Math.round(s.left)} %: можно ${kindText(s.kind)}`;
/** Same word, same folder: what the user must type to switch a project on (compared as typed, after trimming). */
export const confirmMatches = (typed, word) => typeof typed === 'string' && typeof word === 'string' && word.length > 0 && typed.normalize('NFC').trim() === word.normalize('NFC');
