// The context gauge in the chat header (Phase 7.2): how full the context of this chat is, split into rules / skills / conversation, how many steps are
// left before hub starts a fresh session (ADR-018), and a note when a pause has cooled the prompt cache. The numbers come from the server (stored per-call
// sizes); rules and skills are estimates and say so; with no known window there is no bar. Drawn with h()/textContent only (ADR-012).
import { api } from '../api.js';
import { chip, h } from '../ui.js';
import { cacheLine, contextModel, gaugeText, segments } from '../context-model.js';

const LIVE_MS = 4000, IDLE_MS = 30000, TICK_MS = 15000;
const LEVEL_CHIP = { amber: ['Контекст становится большим', 'warn'], red: ['Пора начать новую сессию', 'err'] };
const KIND_RU = { system: 'система', rules: 'правила', skills: 'скиллы', conversation: 'разговор' };

/** `node` goes into the chat header; `show(runId)` points it at a thread's newest run, `refresh()` re-reads now, `stop()` ends the timers. */
export function contextGauge() {
  const node = h('div.ctx', { hidden: true });
  let runId = null, m = null, at = 0, poll = 0, tick = 0, seq = 0;

  const draw = () => {
    if (!m) { node.hidden = true; node.replaceChildren(); return; }
    node.hidden = false;
    node.className = 'ctx is-' + m.level;
    const pieces = gaugeText(m), segs = segments(m), cl = cacheLine(m, (Date.now() - at) / 1000), lvl = m.used !== null ? LEVEL_CHIP[m.level] : null;
    const label = pieces.join(', ') + (m.breakdown ? '. Правила и скиллы здесь оценка' : '');
    node.replaceChildren(
      h('div.ctx-text', h('b.ctx-main', pieces[0]), pieces.slice(1).map((t) => h('span.ctx-bit', t)), lvl ? chip(lvl[0], lvl[1]) : null, cl ? chip(cl.text, cl.tone) : null),
      segs.length ? h('div.ctx-bar', { role: 'img', 'aria-label': label, title: 'Правила и скиллы здесь оценка по размеру файлов; остальное измерено' },
        segs.map((s) => h('i.ctx-seg.ctx-' + s.kind, { style: { width: s.pct + '%' }, title: KIND_RU[s.kind] })),
        m.window && m.window > m.handoffAt ? h('i.ctx-tick', { style: { left: (m.handoffAt / m.window) * 100 + '%' }, title: 'Здесь hub начнёт новую сессию из короткой записи' }) : null) : null);
  };

  async function load() {
    const id = runId, mine = ++seq;
    if (!id) return;
    const next = contextModel(await api.get(`/runs/${id}/context`, true).catch(() => null));
    if (mine !== seq || id !== runId) return;   // another thread was opened meanwhile
    m = next; at = Date.now(); draw();
    clearTimeout(poll);
    poll = setTimeout(load, m?.live ? LIVE_MS : IDLE_MS);   // until stop(): the chat closes it on the way out
  }
  return {
    node,
    show(id) {
      if (id === runId) return;
      runId = id || null; if (!runId) m = null;   // inside one thread the old reading stays until the new one arrives: no flicker
      seq++; clearTimeout(poll); draw();
      if (runId) load();
      clearInterval(tick); tick = setInterval(() => { if (m && node.isConnected) draw(); }, TICK_MS);   // the cache countdown keeps running between polls
    },
    refresh() { if (runId) load(); },
    stop() { runId = null; seq++; clearTimeout(poll); clearInterval(tick); },
  };
}
