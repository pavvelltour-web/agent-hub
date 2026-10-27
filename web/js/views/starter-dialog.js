import { api } from '../api.js';
import { btn, chip, closeBtn, dialog, h, icon, toast } from '../ui.js';

/** Bytes → "9,6 КБ". */
const kb = (n) => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1).replace('.', ',')} КБ`);
/** What a file shows before "Показать все файлы полностью" (the box scrolls; it is only shorter on screen). */
export const DEFAULT_VIEW_BYTES = 3000;

/**
 * The confirm step of the starter kit. Every byte the digest covers is in the page: each file is a collapsible block holding its FULL text.
 * Installing needs three things in this order: "Показать все файлы полностью" (opens every file, no height limit) → "Я прочитал(а) все файлы" → "Установить".
 * Skills with hooks:/allowed-tools: or an unknown license start unticked. `r` is the /starter/plan answer; `onInstalled(result)` runs after a successful apply.
 */
export function starterDialog({ r, ids, onInstalled }) {
  const close = () => document.getElementById('dlg').close();
  const ticked = new Set(r.skills.filter((s) => s.defaultChecked).map((s) => s.id));
  const total = r.changes.reduce((n, c) => n + c.bytes, 0);
  const longer = r.changes.filter((c) => c.bytes > DEFAULT_VIEW_BYTES);
  const notes = [...(r.skipped || []).map((s) => `${s.id}: ${s.reason}`), ...r.notes,
    ...(longer.length ? [`Файлов длиннее видимой по умолчанию части: ${longer.length}. Нажмите «Показать все файлы полностью»: без этого установка недоступна.`] : [])];

  let expanded = false;
  const root = h('div.stack.sd');
  const detailsOf = [];
  const read = h('input.check', { type: 'checkbox', disabled: true, 'aria-label': 'Я прочитал(а) все файлы' });
  const go = btn('Установить в библиотеку', { kind: 'primary', disabled: true });
  const sync = () => { read.disabled = !expanded; if (!expanded) read.checked = false; go.disabled = !(expanded && read.checked && ticked.size); };
  read.addEventListener('change', sync);

  const showAll = btn(`Показать все файлы полностью (${r.changes.length}, ${kb(total)})`, { kind: 'glass', onclick: () => {
    expanded = true; root.classList.add('sd-full'); for (const d of detailsOf) d.open = true; showAll.disabled = true; sync();
  } });

  const section = (s) => {
    const mine = r.changes.filter((c) => c.path.startsWith(`skills/${s.id}/`));
    const box = h('input.check', { type: 'checkbox', checked: ticked.has(s.id), 'aria-label': `Установить ${s.id}`, onchange: (e) => { e.target.checked ? ticked.add(s.id) : ticked.delete(s.id); sync(); } });
    const files = mine.map((c) => {
      const d = h('details.plate.sd-file', h('summary', h('span.mono', c.path.slice(`skills/${s.id}/`.length)), chip(kb(c.bytes), 'line'), c.note && /код:/.test(c.note) ? chip('может запуститься', 'warn', c.note) : null),
        c.note && /код:/.test(c.note) ? h('p.t-meta', c.note.replace(/^.*?(код:)/, '$1')) : null, h('pre.sd-text', c.after));
      detailsOf.push(d);
      return d;
    });
    return h('section.plate.sd-skill.stack', { style: { padding: '12px 14px' } },
      h('label.row-flex', box, h('b', s.id), chip(s.licenseKnown ? `${s.license} · по данным списка` : 'лицензия не указана', s.licenseKnown ? 'line' : 'warn'), chip(`коммит ${s.commit.slice(0, 7)}`, 'soft', s.commit),
        s.runsCode ? chip('есть код', 'warn') : null, ...s.flags.map((f) => chip(f.key + ':', 'warn'))),
      s.defaultChecked ? null : h('p.t-meta', s.flags.length ? 'Не отмечен по умолчанию: скилл задаёт ' + s.flags.map((f) => f.key + ':').join(' и ') + '. Прочитайте значения выше.' : 'Не отмечен по умолчанию: лицензия не указана.'),
      h('div.stack', { style: { gap: '8px' } }, files));
  };

  root.append(
    h('div.bar', h('div', h('h2.t-title', 'Набор скиллов'), h('p.t-meta', 'Пока вы не подтвердите, ничего не записано. Скиллы попадут только в библиотеку hub и не видны агентам, пока вы не подключите их к проекту.')), closeBtn()),
    notes.length ? h('div.alert.warn', icon('alert'), h('div.stack', notes.map((n) => h('span', n)))) : null,
    h('div.row-flex', showAll, h('span.t-meta', `Файлов: ${r.changes.length}, всего ${kb(total)}`)),
    ...r.skills.map(section),
    h('div.foot.sd-foot', h('label.row-flex', read, h('span', 'Я прочитал(а) все файлы')), btn('Отмена', { kind: 'glass', onclick: close }), go));

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const a = await api.post('/starter/apply', { ids, digest: r.digest, approved: true, install: [...ticked] });
      close(); onInstalled(a);
    } catch { sync(); /* api shows the toast; a 409 means the text changed: plan again */ }
  });
  dialog(root, { wide: true });
  if (!ticked.size) toast('Ни один скилл не отмечен по умолчанию: отметьте нужные после чтения');
}
