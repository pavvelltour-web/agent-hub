// CLI-like transcript: renders stored/live run events the way Claude Code and Codex show them (compact rows, monospace for tools).
// Every text from an agent goes in through textContent (h() children); nothing here builds markup from data (ADR-012).
// One `ctx` per run: { agent, tools: Map<toolId, row>, override?, after? }. Everything else lives in ctx.st (created on first use).
import { agentName, fmt, h, linkBtn, md } from './ui.js';

const FAMILY = {
  read: ['read', 'notebookread'],
  search: ['grep', 'glob', 'ls', 'websearch', 'web_search', 'toolsearch'],
  bash: ['bash', 'bashoutput', 'shell', 'killshell'],
  edit: ['edit', 'multiedit', 'write', 'notebookedit'],
  todo: ['todowrite', 'update_plan'],
  sub: ['task', 'agent'],
};
const familyOf = (name) => { const n = (typeof name === 'string' ? name : '').toLowerCase(); for (const [f, names] of Object.entries(FAMILY)) if (names.includes(n)) return f; return 'other'; };

const HEAD = 5;          // bash output lines shown before the expander
const DIFF_HEAD = 8;     // diff lines shown before the expander
const CHUNK = 300;       // lines added per expander click: a 64 KB body never lands in the DOM at once
const OUTCOME = { done: 'Готово', review: 'На ревью', failed: 'Ошибка', limit: 'Остановлено лимитом', stopped: 'Остановлено вами', guard: 'Остановлено защитой от лишних расходов', 'guard-stop': 'Остановлено защитой: общий порог (за сутки или цепочка)', context: 'Продолжено в новой сессии', interrupted: 'Прервано' };
const KIND = { add: 'новый файл', delete: 'удалён', update: 'изменён' };

const plural = (n, [one, few, many]) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
export const nLines = (n) => `${n} ${plural(n, ['строка', 'строки', 'строк'])}`;
const nMatches = (n) => `${n} ${plural(n, ['совпадение', 'совпадения', 'совпадений'])}`;
/** 650 → «650 токенов»; 2100 → «2.1 тыс. токенов». */
export const tokenWords = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} тыс. токенов` : `${n} ${plural(n, ['токен', 'токена', 'токенов'])}`);
export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (ms < 1000) return '<1 с';
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.floor(s / 60)} м ${s % 60} с`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} м`;
}
// Stored rows may predate the server-side sanitizer: every field read from event data goes through these, never String(x) (`{toString:1}` throws).
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Lookup in a fixed table by a key from event data: only own string keys, so an object key cannot throw or reach the prototype. */
const pick = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
const oneLine = (s, n = 240) => { const t = str(s).split('\n')[0]; return t.length > n || str(s).includes('\n') ? t.slice(0, n) + '…' : t; };

/** Per-row bookkeeping, kept out of the DOM. */
const ROW = new WeakMap();
const state = (ctx) => (ctx.st ||= { subs: [], todo: null, partial: null, last: null, usage: null, t0: null });

// ---------- small parts ----------
const mark = (glyph) => h('span.tx-mark' + (glyph ? '.is-glyph' : ''), { 'aria-hidden': 'true' }, glyph || null);
const corner = () => h('span.tx-corner', { 'aria-hidden': 'true' });

/** Lines as <pre> of block spans: the first `head` at once, the rest on demand in chunks, so a 64 KB body cannot freeze the page. */
function lineView(lines, { head, mk, truncated }) {
  const pre = h('pre.tx-pre');
  const wrap = h('div.tx-lines', pre);
  let shown = 0, btn = null;
  const more = (n) => {
    for (const l of lines.slice(shown, shown + n)) pre.append(mk(l));
    shown = Math.min(lines.length, shown + n);
    const left = lines.length - shown;
    if (left > 0) {
      btn ||= h('button.tx-more', { type: 'button', onclick: () => more(CHUNK) });
      btn.textContent = '+' + nLines(left);
      if (!btn.isConnected) wrap.append(btn);
    } else {
      btn?.remove();
      if (truncated && !wrap.querySelector('.tx-cut')) wrap.append(h('div.tx-cut', 'Показано не всё: вывод обрезан до 64 тыс. символов'));
    }
  };
  more(head);
  return wrap;
}
const textLines = (text) => str(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
const plainLine = (l) => h('span.l', l === '' ? ' ' : l);
const bodyView = (text, { head = HEAD, truncated } = {}) => lineView(textLines(text), { head, mk: plainLine, truncated });
const diffLine = (l) => h('span.l.' + (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@') ? 'hunk' : 'ctx'), l === '' ? ' ' : l);

function res(...kids) { const r = h('div.tx-res', corner(), h('div.tx-resbody', kids)); return r; }
const errRes = (r) => { r.classList.add('is-err'); return r; };
/** Result text of a tool: its body (or the short summary for old records) with the first lines visible. */
function resultBlock(d, head = HEAD) {
  const body = typeof d.body === 'string' ? d.body : str(d.summary);
  if (!body.trim()) return h('span.tx-muted', d.isError ? '(ошибка без текста)' : '(нет вывода)');
  return bodyView(body, { head, truncated: d.truncated });
}

// ---------- rows ----------
function textRow(text) { return h('div.tx-row.tx-text', mark(), h('div.tx-body', md(text))); }

function thinkRow(d) {
  const tokens = typeof d.tokens === 'number' && Number.isFinite(d.tokens) ? ` (${tokenWords(d.tokens)})` : '';
  const box = h('div.tx-fold-body');
  const det = h('details.tx-fold.tx-think', h('summary', h('span.tx-label', 'Размышление'), tokens ? h('span.tx-meta', tokens) : null, h('span.tx-caret', { 'aria-hidden': 'true' }, '▸')), box);
  det.addEventListener('toggle', () => { if (det.open && !box.firstChild) box.append(bodyView(str(d.text), { head: 14 })); });
  return h('div.tx-row.tx-thinking', mark('✻'), det);
}

function todoCounts(items0) {
  const items = items0.filter((i) => i && typeof i === 'object'), done = items.filter((i) => i.state === 'done').length;
  return `Задачи (${done} из ${items.length})`;
}
function todoItems(items) {
  return items.filter((i) => i && typeof i === 'object').map((i) => h('li.tx-todo-i', { dataset: { state: str(i.state) } }, h('span.tx-box', { 'aria-label': i.state === 'done' ? 'готово' : i.state === 'active' ? 'в работе' : 'ждёт' }), h('span.tx-todo-t', str(i.text))));
}
function todoRow(ctx, items, at) {
  const s = state(ctx);
  if (s.todo) { s.todo.head.textContent = todoCounts(items); s.todo.list.replaceChildren(...todoItems(items)); return; }   // later todo event: update in place
  const head = h('div.tx-head', todoCounts(items)), list = h('ul.tx-todo-l', todoItems(items));
  s.todo = { head, list };
  at.append(h('div.tx-row.tx-todo', mark(), h('div.tx-main', head, list)));
}

function labelFor(fam, name0, codex) {
  const name = typeof name0 === 'string' ? name0 : '';
  if (fam === 'read') return 'Прочитал';
  if (fam === 'search') return codex ? 'Искал' : 'Поиск';
  if (fam === 'bash') return codex ? 'Выполнил' : name && name.toLowerCase() !== 'shell' ? name : 'Bash';
  if (fam === 'edit') return codex ? 'Изменил' : String(name).toLowerCase() === 'write' ? 'Запись' : 'Правка';
  if (fam === 'sub') return 'Субагент';
  return name || 'Инструмент';
}
function argFor(fam, d, input) {
  if (fam === 'read') return str(input.file_path) || str(input.path) || d.summary;
  if (fam === 'search') return str(input.pattern) || str(input.query) || d.summary;
  if (fam === 'bash') return str(input.command) || d.summary;
  if (fam === 'edit') return str(input.file_path) || str(input.notebook_path) || (Array.isArray(input.changes) ? '' : d.summary);
  if (fam === 'sub') return str(input.description) || str(input.subagent_type) || d.summary;
  return d.summary || '';
}

function toolRow(ctx, d, at) {
  const s = state(ctx), codex = ctx.agent === 'codex', fam = familyOf(d.name), input = d.input && typeof d.input === 'object' ? d.input : {};
  if (fam === 'todo') { ctx.tools.set(d.id ?? '', h('span')); ROW.set(ctx.tools.get(d.id ?? ''), { fam: 'todo' }); return; }   // the todo event draws the checklist
  const arg = str(argFor(fam, d, input)), full = arg;
  const cnt = h('span.tx-cnt'), nm = h('span.tx-label', labelFor(fam, d.name, codex));
  const head = h('div.tx-head', nm, arg ? h('code.tx-arg', { title: full }, oneLine(arg)) : null, cnt);
  if (fam === 'sub') {
    const nest = h('div.tx-nest');
    const det = h('details.tx-fold.tx-sub', h('summary', nm, arg ? h('code.tx-arg', { title: full }, oneLine(arg, 120)) : null, cnt, h('span.tx-caret', { 'aria-hidden': 'true' }, '▸')), nest);
    const row = h('div.tx-row.tx-tool', { dataset: { fam } }, mark(), det);
    ROW.set(row, { fam, nest, cnt, main: nest, done: false });
    ctx.tools.set(d.id ?? '', row); at.append(row); s.last = row; s.subs.push({ row, nest });
    return;
  }
  const main = h('div.tx-main', head);
  const row = h('div.tx-row.tx-tool', { dataset: { fam } }, mark(codex ? '•' : null), main);
  ROW.set(row, { fam, main, cnt, path: fam === 'edit' ? str(input.file_path) || str(input.notebook_path) : '', changes: Array.isArray(input.changes) ? input.changes : [], diffs: 0, done: false });
  ctx.tools.set(d.id ?? '', row); at.append(row); s.last = row;
}

function orphanResult(d, at) { at.append(h('div.tx-row.tx-orphan' + (d.isError ? '.is-err' : ''), mark(), res(resultBlock(d)))); }

function toolResult(ctx, d, at) {
  const s = state(ctx), row = ctx.tools.get(d.id ?? ''), r = row && ROW.get(row);
  if (!r || r.done) { orphanResult(d, at); return; }
  if (r.fam === 'todo') return;
  r.done = true;
  if (d.isError) row.classList.add('is-err');
  const put = (el) => r.main.append(d.isError ? errRes(el) : el);
  if (r.fam === 'sub') {
    put(res(resultBlock(d, 8)));
    const i = s.subs.findIndex((x) => x.row === row);
    if (i >= 0) s.subs.splice(i);       // the sub-agent (and anything opened inside it) is finished
    return;
  }
  if (r.fam === 'read') {
    if (d.isError) put(res(resultBlock(d)));
    else r.cnt.textContent = num(d.lines) > 0 ? `(${nLines(num(d.lines))})` : '(пусто)';
  } else if (r.fam === 'search') {
    if (d.isError) put(res(resultBlock(d)));
    else { const n = str(d.body).trim() ? num(d.lines) : 0; put(res(h('span.tx-sum', `Нашёл ${nMatches(n)}`), n > 0 ? bodyView(d.body, { head: 0, truncated: d.truncated }) : null)); }
  } else if (r.fam === 'edit') {
    if (d.isError || !r.diffs) put(res(resultBlock(d)));       // a diff already says what changed
  } else put(res(resultBlock(d)));
}

/** Diff of the tool row just above (Claude Edit/MultiEdit, Codex file_change) or a row of its own. */
function diffRow(ctx, d0, at) {
  const s = state(ctx), d = { path: str(d0.path), added: num(d0.added), removed: num(d0.removed), hunks: str(d0.hunks) };
  let row = s.last && ROW.get(s.last)?.fam === 'edit' ? s.last : null;
  let r = row && ROW.get(row);
  if (!r) {
    const cnt = h('span.tx-cnt'), main = h('div.tx-main', h('div.tx-head', h('span.tx-label', 'Правка'), h('code.tx-arg', { title: d.path }, oneLine(d.path)), cnt));
    row = h('div.tx-row.tx-tool', { dataset: { fam: 'edit' } }, mark(), main);
    r = { fam: 'edit', main, cnt, path: d.path, changes: [], diffs: 0, done: true };
    ROW.set(row, r); at.append(row); s.last = row;
  }
  const known = (d.added || 0) + (d.removed || 0) > 0;
  const counts = () => h('span', '(', h('span.tx-add', '+' + (d.added || 0)), ' ', h('span.tx-del', '−' + (d.removed || 0)), ')');
  if (known && r.diffs === 0 && r.path) r.cnt.replaceChildren(counts());
  const separate = !r.path || r.diffs > 0;
  const kind = pick(KIND, r.changes.find((c) => c && typeof c === 'object' && c.path === d.path)?.kind);
  const box = h('div.tx-diff');
  if (separate) box.append(h('div.tx-file', h('code', d.path), known ? counts() : null, kind ? h('span.tx-meta', kind) : null));
  if (d.hunks) box.append(lineView(textLines(d.hunks), { head: DIFF_HEAD, mk: diffLine }));
  r.diffs++;
  r.main.append(res(box));
}

function footer(ctx, d) {
  const s = state(ctx), u = s.usage;
  const ms = (u && typeof u.ms === 'number' && Number.isFinite(u.ms) ? u.ms : null) ?? (s.t0 != null && s.tEnd != null ? s.tEnd - s.t0 : null);
  const label = pick(OUTCOME, d.outcome) || str(d.outcome) || 'Конец';
  const parts = [ms ? `${label} за ${duration(ms)}` : label];
  if (u) {
    parts.push(`вход ${fmt.tok(num(u.uncachedIn) + num(u.cachedIn))}${num(u.cachedIn) ? ` (кэш ${fmt.tok(num(u.cachedIn))})` : ''}`, `выход ${fmt.tok(num(u.out))}`);
    if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd) parts.push('$' + u.costUsd.toFixed(3));
  }
  return h('div.tx-foot' + (d.outcome && d.outcome !== 'done' && d.outcome !== 'review' && d.outcome !== 'context' ? '.is-bad' : ''), parts.join(' · '));
}

// ---------- public API ----------
/** Render one stored/live event into `container` (or into the open sub-agent). `ctx` = { agent, tools: Map, override?(e), after?(e) }. */
export function renderEvent(container, e, ctx) {
  const s = state(ctx), d = e.data && typeof e.data === 'object' ? e.data : {}, k = e.kind;
  if (typeof e.ts === 'string') { const t = Date.parse(e.ts); if (s.t0 == null) s.t0 = t; s.tEnd = t; }
  if (ctx.override?.(e)) return;
  const at = s.subs.length ? s.subs.at(-1).nest : container;
  switch (k) {
    case 'text': {
      const row = textRow(str(d.text));
      if (s.partial) { s.partial.el.replaceWith(row); s.partial = null; } else at.append(row);     // the final text replaces the live one: never both
      break;
    }
    case 'partial': {
      if (!s.partial) { const body = h('div.tx-body.tx-live'); s.partial = { el: h('div.tx-row.tx-text.is-live', mark(), body), body, text: '' }; at.append(s.partial.el); }
      s.partial.text += str(d.text); s.partial.body.textContent = s.partial.text;
      break;
    }
    case 'user': at.append(h('div.msg.user', h('div.bubble', str(d.text)))); break;       // history only: a live run draws its prompt in renderRun
    case 'thinking': at.append(thinkRow(d)); break;
    case 'tool': toolRow(ctx, d, at); break;
    case 'tool_result': toolResult(ctx, d, at); break;
    case 'diff': diffRow(ctx, d, at); break;
    case 'todo': todoRow(ctx, Array.isArray(d.items) ? d.items : [], at); break;
    case 'usage': s.usage = d; break;
    case 'unknown': at.append(h('div.tx-row.tx-unknown', mark(), h('span.tx-muted', `Неизвестное событие: ${str(d.type) || '?'}`))); break;
    case 'warn': {
      const m = str(d.message), next = /^context_continue:(r[a-z0-9]+)$/.exec(m);   // the runner names the run that continues this one from its card
      if (next) at.append(h('div.note', h('div.stack', h('span', { style: { fontSize: '14px' } }, 'Контекст стал большим: работа продолжается в новой сессии по короткой записи о сделанном.'), h('div', linkBtn('Открыть новую сессию', '#/chat/' + next[1], 'glass', 'handoff')))));
      else at.append(h('div.note', m));
      break;
    }
    case 'error': at.append(h('div.tx-row.tx-orphan.is-err', mark(), h('div.tx-body', str(d.message) || 'Ошибка'))); break;
    case 'limit': if (d.reached) at.append(h('div.tx-row.tx-orphan.is-err', mark(), h('div.tx-body', `Лимит исчерпан. ${str(d.message)}`))); break;
    case 'end': s.partial?.el.remove(); s.partial = null; s.subs.length = 0; container.append(footer(ctx, d)); break;
    default: break;      // session, done and anything newer than this build: nothing to draw
  }
  if (s.subs.length) for (const x of s.subs) { const n = x.nest.childElementCount; ROW.get(x.row).cnt.textContent = n ? `(${n})` : ''; }
  ctx.after?.(e);
}

/** A whole run: notes, the user's message, then its events. Returns the ctx so a live stream can continue into it. */
export function renderRun(container, run, events, opts = {}) {
  const ctx = { agent: run.agent, tools: new Map(), ...opts };
  if (run.resumeOf?.startsWith('session:')) container.append(h('div.note', 'Продолжение разговора из истории: агент помнит, что было раньше'));
  if (run.handoffOf && /Its context grew large/.test(run.prompt || '')) container.append(h('div.note', 'Новая сессия: прежняя стала слишком большой, поэтому агент получил короткую запись о сделанном, а не весь чат'));
  else if (run.handoffOf) container.append(h('div.note', `Продолжение после лимита: ${agentName(run.agent)} получил короткую запись о сделанном, а не весь чат`));
  else if (run.prompt) container.append(h('div.msg.user', h('div.bubble', run.prompt)));      // a session from the history has no prompt of its own: its `user` events are in the stream
  for (const e of events) renderSafe(container, e, ctx);
  return ctx;
}

/** renderEvent for one row from storage or the live stream: a row that cannot be drawn becomes a neutral line, the thread goes on. */
export function renderSafe(container, e, ctx) {
  try { renderEvent(container, e, ctx); } catch { container.append(h('div.tx-row.tx-unknown', mark(), h('span.tx-muted', 'Не удалось показать событие'))); }
}
