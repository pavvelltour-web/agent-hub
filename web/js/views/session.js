import { api } from '../api.js';
import { renderRun, renderSafe } from '../transcript.js';
import { agentBadge, agentName, btn, chip, fmt, h, toast } from '../ui.js';
import { go, pageHead } from './common.js';

const PAGE = 200;
const PERMS = [['plan', 'Только читать'], ['edit', 'Править файлы']];

export default async function view(ctx) {
  const id = ctx.params[0], enc = encodeURIComponent(id);
  const s = (await api.get(`/sessions/${enc}?limit=1`)).session;     // the index only: title, counts, usage. The conversation itself is read from the agent's own file.
  const who = s.agent === 'codex' ? 'Codex' : 'Claude';

  // ---------- the conversation: same renderer as the live chat, read page by page from the source file ----------
  const list = h('div.transcript.is-page');
  const more = h('div.sess-more');
  let tctx = null, next = 0, busy = false;
  const note = (kind, ...kids) => list.replaceChildren(h('div.alert' + (kind ? '.' + kind : ''), ...kids));
  async function loadMore() {
    if (busy) return;
    busy = true; more.replaceChildren();
    try {
      const r = await api.get(`/sessions/${enc}/events?limit=${PAGE}&offset=${next}`, true);
      if (r.moved) { note('warn', h('div.stack', h('b', 'Файл разговора перемещён или удалён'), h('span.t-meta', `Hub читает историю прямо из файла ${who}, а его больше нет на прежнем месте. В списке остались только название и счётчики.`))); return; }
      tctx ||= renderRun(list, { agent: s.agent, prompt: '' }, []);
      next = r.next;   // advance first: a row that throws must not make "Повторить" draw the page twice
      for (const e of r.events) renderSafe(list, e, tctx);      // one odd row becomes a neutral line, the page goes on
      if (!list.childElementCount) list.append(h('div.note', 'В файле нет сообщений, которые можно показать'));
      if (next != null) more.replaceChildren(btn('Показать ещё', { kind: 'glass', onclick: loadMore }));
    } catch (e) {
      const m = e.status === 403 ? 'Hub не стал читать этот файл: он лежит вне папок истории агентов.' : 'Не удалось прочитать файл разговора.';
      if (tctx) { more.replaceChildren(h('span.t-meta', m), btn('Повторить', { kind: 'glass', onclick: loadMore })); } else note('warn', m);
    } finally { busy = false; }
  }
  await loadMore();

  // ---------- continue: the same agent picks up its own memory of this conversation, in the project folder ----------
  let perm = 'edit';       // what the server applies when nothing is sent; shown and sent explicitly so the label is the truth
  const permRow = h('div.pills.glass', { role: 'group', 'aria-label': 'Права агента' });
  const drawPerm = () => permRow.replaceChildren(...PERMS.map(([k, t]) => h('button.pill', { type: 'button', 'aria-pressed': String(perm === k), title: k === 'plan' ? 'Агент только читает и планирует' : 'Агент правит файлы проекта', onclick: () => { perm = k; drawPerm(); } }, t)));
  drawPerm();
  const ta = h('textarea.textarea', { rows: 2, placeholder: 'Что сделать дальше?', 'aria-label': 'Продолжение' });
  const go2 = async () => {
    const t = ta.value.trim(); if (!t) return toast('Напишите, что сделать дальше', 'err');
    try { const r = await api.post('/runs', { prompt: t, resumeSessionId: s.id, permission: perm }); go(`/p/${s.projectId}/chat/${r.run.id}`); } catch { /* api shows the toast */ }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go2(); } });
  const cont = s.parentId ? null : s.projectId
    ? h('section.plane.card.stack', { style: { marginBottom: '18px' } }, h('b.t-label', `Продолжить этот разговор в ${agentName(s.agent)}`), h('p.t-meta', `${who} вспомнит всё, что было выше, и продолжит в папке проекта «${s.project}».`), permRow, ta, h('div', btn('Продолжить', { kind: 'primary', icon: 'send', onclick: go2 })))
    : h('section.plane.card.stack', { style: { marginBottom: '18px' } }, h('b.t-label', 'Продолжить нельзя'), h('p.t-meta', 'Папка этого разговора не добавлена как проект. Добавьте её на странице «Проекты», и кнопка появится.'));

  return { title: s.title || 'Разговор', node: h('div',
    pageHead({ crumbs: [{ text: 'История', href: '/history' }, ...(s.projectId ? [{ text: s.project, href: '/p/' + s.projectId }] : [])], title: (s.title || 'Разговор').slice(0, 70), sub: `${fmt.date(s.startedAt)} · сообщений: ${s.msgCount}` }),
    h('div.row-flex', { style: { marginBottom: '16px' } }, agentBadge(s.agent), chip(fmt.model(s.model), 'line'), chip(fmt.tok(s.tokens) + ' токенов', 'line'), s.parentId ? chip('часть другого разговора (субагент)', 'info') : null),
    cont, list, more, h('p.t-meta', { style: { marginTop: '18px' } }, 'Hub только читает файлы истории агентов и ничего в них не меняет.')) };
}
