import { api } from '../api.js';
import { avatar, btn, chip, debounce, empty, fmt, h, icon } from '../ui.js';
import { addProjectDialog, go, linkProject, pageHead } from './common.js';

export default async function view() {
  const projects = await api.get('/projects');
  const grid = h('div.cards');
  const input = h('input.input', { type: 'search', placeholder: 'Найти проект', 'aria-label': 'Поиск проектов' });
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const items = projects.filter((p) => !q || p.slug.toLowerCase().includes(q) || p.root.toLowerCase().includes(q));
    grid.replaceChildren(...(items.length ? items.map(card) : [empty(projects.length ? 'Ничего не найдено' : 'Проектов пока нет', projects.length ? null : 'Нажмите «Открыть папку» и выберите папку с вашей работой.')]));
  };
  input.addEventListener('input', debounce(draw, 120));
  draw();
  return { title: 'Проекты', node: h('div', pageHead({ title: 'Проекты', sub: 'Проект — это папка с вашей работой. Claude и Codex, которые работали в одной папке, считаются одним проектом.', actions: btn('Открыть папку…', { kind: 'primary', icon: 'folder', onclick: () => addProjectDialog((id) => go('/p/' + id)) }) }),
    projects.length > 6 ? h('div.search', { style: { maxWidth: '420px', marginBottom: '18px' } }, icon('search', 'sm'), input) : null, grid) };
}

function card(p) {
  const sessions = (p.claude || 0) + (p.codex || 0);
  return h('a.project-card.plane', { href: '#/p/' + p.id, 'aria-label': 'Проект ' + p.slug },
    h('div', h('h3.t-heading', p.slug), h('div.path', { title: p.root }, p.root)),
    sessions ? h('div.row-flex', { style: { gap: '14px' } },
      h('span.row-flex', { style: { gap: '6px' } }, avatar('claude'), h('span', `${p.claude || 0} разг. в Claude`)),
      h('span.row-flex', { style: { gap: '6px' } }, avatar('codex'), h('span', `${p.codex || 0} в Codex`))) : h('div.t-meta', 'Разговоров с агентами пока не было'),
    h('div.row-flex', { style: { justifyContent: 'space-between' } },
      h('span.t-meta', p.lastAt ? 'Последний раз: ' + fmt.ago(p.lastAt) : ''),
      !p.exists ? chip('папка не найдена', 'warn') : p.linked ? chip('Claude и Codex связаны', 'ok') : btn('Связать Claude и Codex', { kind: 'glass', class: 'btn-sm', title: 'Общие правила и скиллы для обоих', onclick: (e) => { e.preventDefault(); e.stopPropagation(); linkProject(p.id, () => location.reload()); } })));
}
