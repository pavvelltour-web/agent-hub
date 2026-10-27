// The cascade as steps in a task thread («Sonnet пишет → Opus разбирает → Opus правит», each step's verify result), and the approval of the verify
// command. Model output and verify output are untrusted: typed by cascade-model.js, drawn with h()/textContent only (ADR-012).
import { api } from '../api.js';
import { btn, chip, closeBtn, dialog, h, icon, toast } from '../ui.js';
import { STATUS_RU, VERIFY_RU, cascadeModel, stepsLine } from '../cascade-model.js';
import { argVis, checkPlanOf, vis } from '../review-model.js';

const POLL_MS = 2500;

/** One step: who, what the verify said, and the verify output of that step when it was red. */
function stepRow(projectId, r) {
  const [vt, tone] = VERIFY_RU[r.verify];
  return h('div.stack.rv-gap', { 'data-step': r.role },
    h('div.row-flex.rv-meta', chip(r.who, 'soft'), chip(vt, tone), r.runId ? h('a.btn.btn-glass', { href: `#/p/${projectId}/chat/${r.runId}` }, 'Открыть запуск') : null),
    r.blocked ? h('p.t-meta.rv-wrap', 'Почему заблокировано: ' + r.blocked) : null,
    r.note ? h('p.t-meta.rv-wrap', r.note) : null,
    r.verify === 'failed' && r.tail ? h('details.rv-checks', h('summary', 'Вывод проверки (последние строки)'), h('pre.rv-pre', r.tail)) : null);
}

/** The card for a thread; `null` when none of its runs belongs to a cascade. Re-reads itself while the cascade is running. */
export async function cascadeCard({ runIds, projectId }) {
  let m = null;
  for (const id of runIds.slice(0, 6)) { m = cascadeModel(await api.get(`/runs/${id}/cascade`, true).catch(() => null)); if (m) break; }
  if (!m) return null;
  const node = h('section.plane.card.stack.rv-gap.rv-card.casc-card', { 'aria-label': 'Каскад проверки' });
  const draw = () => {
    const [st, tone] = STATUS_RU[m.status];
    node.replaceChildren(
      h('div.row-flex.rv-meta', h('b.t-label', 'Каскад проверки'), chip(st, tone), chip('проверка: ' + m.verify.map(argVis).join(' '), 'line')),
      m.rungs.length ? h('p.t-heading.rv-wrap', stepsLine(m)) : null,
      h('div.stack.rv-gap', m.rungs.map((r) => stepRow(projectId, r))),
      m.reason ? h('p.t-meta.rv-wrap', (m.status === 'solved' ? '' : 'Остановились: ') + m.reason) : null,
      m.card ? h('p.t-meta.rv-wrap', 'Запись для передачи: ', h('span.mono', m.card)) : null,
      m.status === 'solved' ? h('p.t-meta', 'Результат ждёт ревью, как любая задача: каскад ничего не принимает.') : null);
  };
  const poll = async () => {
    if (!node.isConnected) return;
    const next = cascadeModel(await api.get(`/runs/${m.id || runIds[0]}/cascade`, true).catch(() => null));
    if (next) { m = next; draw(); }
    if (m.status === 'running') setTimeout(poll, POLL_MS);
  };
  draw();
  if (m.status === 'running') setTimeout(poll, POLL_MS);
  return node;
}

/**
 * Approval of the verify command: shows every byte the digest covers (commands, ALL package.json scripts, file hashes, each value escaped) and
 * sends the digest of exactly that. `raw` is the `plan` of the 400 answer; `onApproved` runs after the server recorded it.
 */
export function verifyApprovalDialog({ projectId, verify, raw, onApproved }) {
  const p = checkPlanOf(raw);
  const close = () => document.getElementById('dlg').close();
  if (!p) return toast('Не удалось показать, что запустит проверка', 'err');
  const runs = new Set(p.runs);
  const blocked = p.tooLarge || p.unreadable;
  const body = [
    h('p', p.note || 'Проверка выполняет код ветки с вашими правами; одобрение покрывает только перечисленное.'),
    h('b.t-label', 'Команда'), h('pre.rv-pre', p.checks.map((c) => c.map(argVis).join(' ')).join('\n')),
    p.scripts.length ? [h('b.t-label', 'Скрипты package.json (все; «▶» — те, что запустятся)'), h('pre.rv-pre', p.scripts.map(([k, v]) => `${runs.has(k) ? '▶' : ' '} ${vis(k)}: ${vis(v)}`).join('\n'))] : null,
    p.files.length ? [h('b.t-label', 'Файлы, которые запустятся (отпечаток SHA-256)'), h('pre.rv-pre', p.files.map(([k, v]) => `${vis(k)}  ${v ?? 'нет в коммите'}`).join('\n'))] : null,
    h('p.t-meta', 'Проверка запускается в чистой копии коммита с работой агента (не в его рабочей папке); node_modules берётся из корня проекта. Если агент изменит скрипты, запускаемые файлы, тесты или настройки тестового раннера, спрячет файлы от git или результат не удастся прочитать, каскад остановится и не засчитает результат. Тесты и всё, что они подключают, в одобрение не входят.')];
  const approve = async () => {
    try { await api.post('/verify/approve', { projectId, verify, digest: p.digest, approved: true }); } catch { return; }
    toast('Проверка одобрена на этом компьютере', 'ok'); close(); onApproved();
  };
  dialog(h('div.stack.rv-gap', h('div.bar', h('h2.t-title', 'Одобрить проверку'), closeBtn()),
    blocked ? h('div.alert.err', { role: 'alert' }, icon('alert'), h('span', p.unreadable || 'Список слишком большой для показа: одобрить его нельзя.')) : body,
    h('div.foot', btn('Отмена', { kind: 'glass', onclick: close }), blocked ? null : btn('Одобрить проверку', { kind: 'primary', icon: 'check', onclick: approve }))), { wide: true });
}
