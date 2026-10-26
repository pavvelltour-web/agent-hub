// Tiny UI toolkit: element builder, icons, formatters, safe markdown, dialog, toast. No innerHTML with data anywhere.

// replaceChildren(null) would insert the text "null"; skip empty children everywhere in the app.
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) { return nativeReplace.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };

/** h('div.card#id', {onclick, class, dataset:{a:1}, aria-label}, ...children) — children: Node | string | number | array | null */
export function h(tag, props, ...kids) {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m ? m[1] : tag);
  if (m && m[2]) for (const p of m[2].match(/[.#][\w-]+/g)) p[0] === '#' ? (el.id = p.slice(1)) : el.classList.add(p.slice(1));
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') v.split(' ').filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && typeof v !== 'object') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k instanceof Node ? k : document.createTextNode(String(k))); }
}
export const frag = (...kids) => { const f = document.createDocumentFragment(); add(f, kids); return f; };
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...kids) => { clear(el); add(el, kids); return el; };

// ---------- icons (constant markup only) ----------
const P = {
  today: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l1 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chat: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  models: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
  library: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><path d="M16.5 13v7M13 16.5h7"/>',
  logs: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  send: '<path d="M5 12l14-7-5 14-3-6z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-6 7"/>',
  handoff: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/>',
  back: '<path d="M15 6l-6 6 6 6"/>', chev: '<path d="M9 6l6 6-6 6"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', refresh: '<path d="M20 11a8 8 0 0 0-14.5-3M4 5v4h4M4 13a8 8 0 0 0 14.5 3M20 19v-4h-4"/>',
  term: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>', file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', task: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'icon ' + cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || P.info;      // constant strings only
  return s;
}

// ---------- small components ----------
export const chip = (text, tone = 'line', title) => h('span.chip.chip-' + tone, { title }, text);
export const btn = (label, o = {}) => h('button.btn' + (o.kind ? '.btn-' + o.kind : ''), { type: 'button', onclick: o.onclick, disabled: o.disabled, title: o.title, 'aria-label': o.aria, class: o.class }, o.icon ? icon(o.icon, 'sm') : null, label);
export const linkBtn = (label, href, kind = 'glass', ic) => h('a.btn.btn-' + kind, { href }, ic ? icon(ic, 'sm') : null, label);
export const avatar = (agent) => h('span.avatar.av-' + (agent === 'codex' ? 'codex' : agent === 'claude' ? 'claude' : 'hub'), { 'aria-hidden': 'true' }, agent === 'codex' ? 'X' : agent === 'claude' ? 'C' : 'h');
export const agentBadge = (agent, text) => h('span.agent-badge', avatar(agent), text || (agent === 'codex' ? 'Codex' : 'Claude'));
export const empty = (title, text, action) => h('div.empty', h('div.t-heading', title), text ? h('p', text) : null, action || null);
export const skeleton = (n = 3) => h('div.stack', Array.from({ length: n }, () => h('div.skeleton', { style: { height: '56px' } })));
export const sectionHead = (title, right) => h('div.section-head', h('h2.t-heading', title), right || null);
export function pills(items, current, onpick, label) {
  return h('div.pills.glass', { role: 'group', 'aria-label': label || '' }, items.map(([k, text, n]) => h('button.pill', { type: 'button', 'aria-pressed': String(k === current), onclick: () => onpick(k) }, text, n != null ? h('span.n', n) : null)));
}
export function meter(pct, risk) {
  return h('div.meter' + (pct == null ? '.none' : risk ? '.risk' : ''), { role: 'progressbar', 'aria-valuenow': pct ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('b', { style: { width: (pct ?? 0) + '%' } }));
}
export const field = (label, control) => h('div.field', h('label', label), control);

// ---------- formatters ----------
export const fmt = {
  ago(iso) {
    if (!iso) return '—';
    const t = typeof iso === 'number' ? iso * 1000 : Date.parse(iso); const s = (Date.now() - t) / 1000;
    if (s < 60) return 'только что'; if (s < 3600) return Math.floor(s / 60) + ' мин назад'; if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
    if (s < 172800) return 'вчера'; if (s < 86400 * 14) return Math.floor(s / 86400) + ' дн назад';
    return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  },
  until(t) {
    const ms = (typeof t === 'number' ? t * 1000 : Date.parse(t)) - Date.now();
    if (!(ms > 0)) return 'уже сброшен';
    const m = Math.round(ms / 60000), d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60);
    return d ? `через ${d} д ${hh} ч` : hh ? `через ${hh} ч ${m % 60} мин` : `через ${m} мин`;
  },
  tok(n) { if (n == null) return '—'; if (n >= 1e9) return (n / 1e9).toFixed(1) + ' млрд'; if (n >= 1e6) return (n / 1e6).toFixed(1) + ' млн'; if (n >= 1e3) return Math.round(n / 1e3) + ' тыс'; return String(n); },
  usd: (n) => (n == null ? 'цена неизвестна' : n < 0.01 ? '<$0.01' : '$' + (n < 10 ? n.toFixed(2) : n.toFixed(0))),
  time: (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''),
  date: (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  model: (m) => (m ? m.replace(/^claude-/, '').replace(/-(\d{8})$/, '').replace(/-(\d)-(\d)/, ' $1.$2').replace(/^(\w)/, (c) => c.toUpperCase()) : 'модель не указана'),
};
export const agentName = (a) => (a === 'codex' ? 'Codex' : a === 'claude' ? 'Claude' : a);

// ---------- safe markdown-lite → DOM ----------
function inline(text) {
  const out = [];
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push(h('code', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push(h('strong', part.slice(2, -2)));
    else out.push(part);
  }
  return out;
}
export function md(text) {
  const root = h('div');
  const parts = String(text).split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((seg, i) => {
    if (i % 2) { root.append(h('pre', h('code', seg.replace(/\n$/, '')))); return; }
    let list = null, ordered = false;
    const flush = () => { list = null; };
    for (const line of seg.split('\n')) {
      const li = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) { const ord = !!li[1]; if (!list || ordered !== ord) { list = h(ord ? 'ol' : 'ul'); ordered = ord; root.append(list); } list.append(h('li', inline(li[2]))); continue; }
      flush();
      const hd = /^#{1,4}\s+(.*)$/.exec(line);
      if (hd) root.append(h('h4', inline(hd[1])));
      else if (line.trim()) root.append(h('p', inline(line)));
    }
  });
  return root;
}

// ---------- dialog & toast ----------
export function dialog(content, { wide = false, onclose } = {}) {
  const d = document.getElementById('dlg');
  d.className = 'sheet' + (wide ? ' wide' : '');
  const opener = document.activeElement;
  mount(d, h('div.in', content));
  const done = () => { d.removeEventListener('close', done); onclose?.(); opener?.focus?.(); };
  d.addEventListener('close', done);
  d.onclick = (e) => { if (e.target === d) d.close(); };
  d.showModal();
  d.querySelector('[data-autofocus]')?.focus();
  return { close: () => d.close(), el: d };
}
export const closeBtn = () => h('button.btn.btn-glass.btn-icon', { type: 'button', 'aria-label': 'Закрыть', onclick: () => document.getElementById('dlg').close() }, icon('close'));
export function toast(msg, tone = '') {
  const t = h('div.toast' + (tone ? '.' + tone : ''), msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'err' ? 7000 : 3500);
}
export async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok'); } catch { toast('Не удалось скопировать', 'err'); } }
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** SVG element builder (charts). Attribute values are set as attributes, text as text nodes: no markup from data. */
export function svgEl(tag, attrs = {}, ...kids) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, String(v));
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(typeof k === 'object' ? k : document.createTextNode(String(k)));
  return e;
}
