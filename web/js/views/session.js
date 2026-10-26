import { api } from '../api.js';
import { agentBadge, agentName, btn, chip, fmt, h, toast } from '../ui.js';
import { go, pageHead } from './common.js';

export default async function view(ctx) {
  const id = ctx.params[0];
  let offset = 0; const PAGE = 200;
  const first = await api.get(`/sessions/${encodeURIComponent(id)}?limit=${PAGE}`);
  const s = first.session;
  const list = h('div.stack.sess');
  const more = h('div');
  const who = s.agent === 'codex' ? 'Codex' : 'Claude';
  const addMsgs = (msgs) => msgs.forEach((m) => list.append(
    m.role === 'tool' ? h('div.m.tool', `⚙ ${m.toolName || 'инструмент'}: ${m.text}`)
      : h('div.m.' + m.role, h('div.who', h('b', m.role === 'user' ? 'Вы' : who), h('span', fmt.time(m.ts))), h('div.tx', m.text))));
  const draw = (r) => { addMsgs(r.messages); offset += r.messages.length; more.replaceChildren(offset < s.msgCount ? btn('Показать ещё', { kind: 'glass', onclick: async () => draw(await api.get(`/sessions/${encodeURIComponent(id)}?limit=${PAGE}&offset=${offset}`)) }) : ''); };
  draw(first);

  // Continue: the same agent picks up its own memory of this conversation, in the project folder.
  const ta = h('textarea.textarea', { rows: 2, placeholder: 'Что сделать дальше?', 'aria-label': 'Продолжение' });
  const go2 = async () => {
    const t = ta.value.trim(); if (!t) return toast('Напишите, что сделать дальше', 'err');
    try { const r = await api.post('/runs', { prompt: t, resumeSessionId: s.id }); go(`/p/${s.projectId}/chat/${r.run.id}`); } catch { /* api shows the toast */ }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go2(); } });
  const cont = s.parentId ? null : s.projectId
    ? h('section.plane.card.stack', { style: { marginBottom: '18px' } }, h('b.t-label', `Продолжить этот разговор в ${agentName(s.agent)}`), h('p.t-meta', `${who} вспомнит всё, что было выше, и продолжит в папке проекта «${s.project}».`), ta, h('div', btn('Продолжить', { kind: 'primary', icon: 'send', onclick: go2 })))
    : h('section.plane.card.stack', { style: { marginBottom: '18px' } }, h('b.t-label', 'Продолжить нельзя'), h('p.t-meta', 'Папка этого разговора не добавлена как проект. Добавьте её на странице «Проекты», и кнопка появится.'));

  return { title: s.title || 'Разговор', node: h('div',
    pageHead({ crumbs: [{ text: 'История', href: '/history' }, ...(s.projectId ? [{ text: s.project, href: '/p/' + s.projectId }] : [])], title: (s.title || 'Разговор').slice(0, 70), sub: `${fmt.date(s.startedAt)} · сообщений: ${s.msgCount}` }),
    h('div.row-flex', { style: { marginBottom: '16px' } }, agentBadge(s.agent), chip(fmt.model(s.model), 'line'), chip(fmt.tok(s.tokens) + ' токенов', 'line'), s.parentId ? chip('часть другого разговора (субагент)', 'info') : null),
    cont, list, more, h('p.t-meta', { style: { marginTop: '18px' } }, 'Hub только читает файлы истории агентов и ничего в них не меняет.')) };
}
