// The context gauge in the chat header (Phase 7.2): how full the context of this chat is, split into rules / skills / conversation, how many steps are
// left before hub starts a fresh session (ADR-018), and a note when a pause has cooled the prompt cache. The numbers come from the server (stored per-call
// sizes); rules and skills are estimates and say so; with no known window there is no bar. Drawn with h()/textContent only (ADR-012).
import { api } from '../api.js';
import { chip, h } from '../ui.js';
import { cacheLine, contextModel, gaugeText, levelChip, segments, tick as limitTick } from '../context-model.js';
import { gaugeController } from '../gauge-controller.js';

const KIND_RU = { system: 'система', rules: 'правила', skills: 'скиллы', conversation: 'разговор' };

/** `node` goes into the chat header; `show(runId)` points it at a thread's newest run, `refresh()` re-reads now, `stop()` ends the timers for good. */
export function contextGauge() {
  const node = h('div.ctx', { hidden: true });
  const draw = (m, at) => {
    if (!m) { node.hidden = true; node.replaceChildren(); return; }
    node.hidden = false;
    node.className = 'ctx is-' + m.level;
    const pieces = gaugeText(m), segs = segments(m), cl = cacheLine(m, (Date.now() - at) / 1000), lvl = levelChip(m), mark = limitTick(m);
    const label = pieces.join(', ') + (m.breakdown ? '. Правила и скиллы здесь оценка' : '');
    node.replaceChildren(
      h('div.ctx-text', h('b.ctx-main', pieces[0]), pieces.slice(1).map((t) => h('span.ctx-bit', t)), lvl ? chip(lvl[0], lvl[1]) : null, cl ? chip(cl.text, cl.tone) : null),
      segs.length ? h('div.ctx-bar', { role: 'img', 'aria-label': label, title: 'Правила и скиллы здесь оценка; остальное измерено' },
        segs.map((s) => h('i.ctx-seg.ctx-' + s.kind, { style: { width: s.pct + '%' }, title: KIND_RU[s.kind] })),
        mark ? h('i.ctx-tick', { style: { left: mark.left + '%' }, title: mark.title }) : null) : null);
  };
  return { node, ...gaugeController({ fetchModel: async (id) => contextModel(await api.get(`/runs/${id}/context`, true).catch(() => null)), render: draw, isConnected: () => node.isConnected }) };
}
