// The journal's filters (project, agent, model, kind): plain JS, no DOM, tested in node (src/run/trace-model.test.ts).
// Rows come from the server and are read by type; a row that lacks the attribute a filter asks for is not shown under that filter.
const KIND_RU = { end: 'Завершение', error: 'Ошибка', warn: 'Предупреждение', limit: 'Лимит', handoff: 'Передача', audit: 'Изменение файлов' };
const str = (v) => (typeof v === 'string' ? v : '');
const pid = (v) => (Number.isInteger(v) && v > 0 ? String(v) : '');

export const kindLabel = (source) => (Object.hasOwn(KIND_RU, source) ? KIND_RU[source] : 'Другое');

/** The values that exist in the rows, so a filter never offers an empty choice. */
export function filterOptions(rows) {
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort();
  return {
    projects: uniq(rows.map((r) => pid(r?.projectId))), agents: uniq(rows.map((r) => (r?.agent === 'claude' || r?.agent === 'codex' ? r.agent : ''))),
    models: uniq(rows.map((r) => str(r?.model).slice(0, 100))), kinds: uniq(rows.map((r) => str(r?.source))),
  };
}

/** `f` = { project, agent, model, kind }: '' means any. */
export const matches = (r, f) => !!r && typeof r === 'object'
  && (!f.project || pid(r.projectId) === f.project) && (!f.agent || r.agent === f.agent)
  && (!f.model || str(r.model).slice(0, 100) === f.model) && (!f.kind || r.source === f.kind);
