import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTING } from '../econ/advisor.ts';
import { REPO_ROOT } from '../core/registry.ts';
import { SCHEMA } from '../history/store.ts';
import { loadStages, stageStatus } from '../stages/engine.ts';

export type Format = 'ascii' | 'mermaid' | 'json';
export interface Graph { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] }
export interface Doc { title: string; sections: { heading: string; lines: string[] }[]; graph?: Graph }
export const KINDS = ['arch', 'data', 'stages', 'routing', 'project', 'handoff'] as const;
export type Kind = (typeof KINDS)[number];

/** Components and the source folder each one lives in. `--check` fails if a listed folder is missing or a src folder is unlisted. */
export const ARCH = [
  { id: 'cli', label: 'hub CLI', dir: 'src/cli', feeds: ['core', 'bench'] },
  { id: 'server', label: 'Сервер + панель (127.0.0.1)', dir: 'src/server', feeds: ['core'] },
  { id: 'core', label: 'Ядро: реестр · lock · компиляторы · скаут · загрузка инструментов · init/undo', dir: 'src/core', feeds: ['adapters', 'history', 'econ', 'stages'] },
  { id: 'stages', label: 'Этапы проекта и ворота', dir: 'src/stages', feeds: [] },
  { id: 'econ', label: 'Экономика и советчик', dir: 'src/econ', feeds: [] },
  { id: 'run', label: 'Запуск: worktree · раннер · карточка передачи', dir: 'src/run', feeds: ['adapters', 'history'] },
  { id: 'bench', label: 'Замер: golden-задачи и цена решённой задачи', dir: 'src/bench', feeds: ['run', 'econ'] },
  { id: 'review', label: 'Ревью-ворота: проверка и находки', dir: 'src/review', feeds: ['history', 'econ'] },
  { id: 'adapters', label: 'Адаптеры агентов (claude, codex)', dir: 'src/adapters', feeds: [] },
  { id: 'history', label: 'Журнал: импорт, индекс, поиск (SQLite)', dir: 'src/history', feeds: [] },
  { id: 'diagram', label: 'Схемы (этот вывод)', dir: 'src/diagram', feeds: [] },
  { id: 'lib', label: 'Общее: пути, секреты, хэш, JSONL', dir: 'src/lib', feeds: [] },
] as const;

const box = (title: string, rows: string[]): string[] => {
  const w = Math.max(title.length + 4, ...rows.map((r) => r.length + 2));
  return [`┌─ ${title} ${'─'.repeat(Math.max(0, w - title.length - 3))}┐`, ...rows.map((r) => `│ ${r.padEnd(w - 2)} │`), `└${'─'.repeat(w)}┘`];
};

function archDoc(): Doc {
  const lines: string[] = ['  вы ─► hub CLI / hub ui', '          │', '          ▼'];
  lines.push(...box('ядро', ARCH.filter((a) => ['core', 'stages', 'econ'].includes(a.id)).map((a) => a.label)));
  lines.push('     │ адаптеры          │ только чтение        │ запись по OK', '     ▼                   ▼                      ▼');
  lines.push(...box('запуск и данные', ARCH.filter((a) => ['run', 'adapters', 'history'].includes(a.id)).map((a) => a.label)));
  lines.push('  агенты: claude CLI · codex CLI   │   ~/.claude  ~/.codex (только чтение)   │   файлы проекта (hub.json, hub.lock.json, AGENTS.md, .hub/)');
  return { title: 'Архитектура', sections: [{ heading: 'Схема', lines }, { heading: 'Папки', lines: ARCH.map((a) => `${a.dir.padEnd(14)} ${a.label}`) }], graph: { nodes: ARCH.map((a) => ({ id: a.id, label: a.label })), edges: ARCH.flatMap((a) => a.feeds.map((t) => ({ from: a.id, to: t }))) } };
}

export interface Table { name: string; cols: { name: string; type: string; pk: boolean; ref?: string }[] }
export function parseSchema(sql = SCHEMA): Table[] {
  const out: Table[] = [];
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g)) {
    const cols: Table['cols'] = [];
    for (const part of (m[2] as string).split(/,(?![^(]*\))/)) {
      const t = part.trim();
      if (/^(UNIQUE|PRIMARY|FOREIGN)/i.test(t)) continue;
      const c = /^(\w+)\s+(\w+)(.*)$/s.exec(t);
      if (!c) continue;
      const ref = /REFERENCES (\w+)/.exec(c[3] ?? '')?.[1];
      cols.push({ name: c[1] as string, type: c[2] as string, pk: /PRIMARY KEY/i.test(c[3] ?? ''), ...(ref ? { ref } : {}) });
    }
    out.push({ name: m[1] as string, cols });
  }
  return out;
}

function dataDoc(entity?: string): Doc {
  const tables = parseSchema().filter((t) => !entity || t.name === entity || t.cols.some((c) => c.ref === entity));
  const sections = tables.map((t) => ({ heading: t.name, lines: t.cols.map((c) => `${c.pk ? '#' : ' '} ${c.name.padEnd(16)} ${c.type}${c.ref ? `  → ${c.ref}` : ''}`) }));
  return { title: 'Модель данных (SQLite-индекс)', sections: [...sections, { heading: 'FTS', lines: ['message_fts (FTS5) — поиск по тексту сообщений'] }], graph: { nodes: tables.map((t) => ({ id: t.name, label: t.name })), edges: tables.flatMap((t) => t.cols.filter((c) => c.ref).map((c) => ({ from: t.name, to: c.ref as string, label: c.name }))) } };
}

function stagesDoc(root?: string): Doc {
  const st = root ? stageStatus(root) : loadStages().map((s) => ({ ...s, state: '—', approvedAt: null as string | null, missing: s.outputs }));
  const icon: Record<string, string> = { approved: '✔', ready: '◐', current: '▶', blocked: '○', '—': ' ' };
  const flow = st.map((s) => `${s.id} ${s.title}`).join(' ─► ');
  return { title: 'Этапы проекта', sections: [{ heading: 'Цепочка', lines: [flow] }, { heading: 'Ворота', lines: st.map((s) => `${icon[s.state] ?? ' '} ${s.id} ${s.title.padEnd(24)} результат: ${s.outputs.join(', ')}${s.missing.length && root ? `   нет: ${s.missing.join(', ')}` : ''}`) }], graph: { nodes: st.map((s) => ({ id: `s${s.id}`, label: s.title })), edges: st.slice(1).map((s, i) => ({ from: `s${(st[i] as { id: number }).id}`, to: `s${s.id}` })) } };
}

function routingDoc(): Doc {
  return { title: 'Маршрутизация моделей', sections: [
    { heading: 'Класс задачи → модель', lines: Object.entries(ROUTING).map(([k, v]) => `${k.padEnd(13)} → ${v.model.padEnd(18)} ${v.effort.padEnd(7)} ${v.reason}`) },
    { heading: 'Лестница при затыке', lines: ['sonnet medium ─(2 провала)► sonnet high ─(3 провала)► opus high + карточка', 'граница безопасности → ревью Opus всегда', 'лимит Claude → Codex (если у него есть запас)', 'субагенты: выключены по умолчанию'] },
  ] };
}

function projectDoc(root: string): Doc {
  const rd = (f: string): any => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return undefined; } };
  const cfg = rd('hub.json'), tk = rd('toolkit.json'), lock = rd('hub.lock.json');
  const st = existsSync(root) ? stageStatus(root) : [];
  const cur = st.find((s) => s.state !== 'approved');
  const tokens = (lock?.entries ?? []).reduce((a: number, e: { tokenCost: number }) => a + (e.tokenCost ?? 0), 0);
  const handoffs = existsSync(join(root, '.hub', 'handoffs')) ? readdirSync(join(root, '.hub', 'handoffs')).length : 0;
  return { title: `Проект ${cfg?.project?.slug ?? root}`, sections: [{ heading: 'Сводка', lines: [
    `тип:      ${cfg?.project?.type ?? '—'}`, `агенты:   ${(cfg?.agents ?? []).filter((a: any) => a.enabled).map((a: any) => a.id).join(', ') || '—'}`,
    `этап:     ${cur ? `${cur.id} ${cur.title} (${cur.state})` : 'все этапы подтверждены'}`,
    `инструменты: ${(tk?.selected ?? []).length} (≈ ${tokens} токенов описаний на ход)`, `карточек передачи: ${handoffs}`] }] };
}

function handoffDoc(path: string): Doc {
  const text = readFileSync(path, 'utf8');
  const g = (k: string): string => new RegExp(`^${k}: (.*)$`, 'm').exec(text)?.[1] ?? '—';
  return { title: 'Передача', sections: [{ heading: 'Поток', lines: [`агент A: ${g('from')}`, `   │ причина: ${g('reason')}${g('resets_at') !== '—' ? ` (сброс ${g('resets_at')})` : ''}`, '   ▼ остановка + контрольный коммит', `ветка ${g('branch')}  head ${g('head_sha').slice(0, 8)}  файлы ${g('files_changed')}`, '   ▼ карточка (факты из git + смысл)', `агент B: ${g('to') !== '—' ? g('to') : 'выбирается советчиком'}`] }] };
}

export function build(kind: Kind, o: { root?: string; entity?: string; file?: string } = {}): Doc {
  switch (kind) {
    case 'arch': return archDoc();
    case 'data': return dataDoc(o.entity);
    case 'stages': return stagesDoc(o.root);
    case 'routing': return routingDoc();
    case 'project': return projectDoc(o.root ?? process.cwd());
    case 'handoff': if (!o.file) throw new Error('handoff needs a card file'); return handoffDoc(o.file);
  }
}

export function render(doc: Doc, fmt: Format): string {
  if (fmt === 'json') return JSON.stringify(doc, null, 2);
  if (fmt === 'mermaid') {
    const g = doc.graph;
    if (!g) return '```mermaid\nflowchart TB\n' + doc.sections.flatMap((s) => s.lines.map((l, i) => `  ${s.heading.replace(/\W/g, '') || 'n'}${i}["${l.replace(/"/g, "'")}"]`)).join('\n') + '\n```';
    const id = (s: string): string => s.replace(/\W/g, '_');
    return '```mermaid\nflowchart LR\n' + g.nodes.map((n) => `  ${id(n.id)}["${n.label.replace(/"/g, "'")}"]`).join('\n') + '\n' + g.edges.map((e) => `  ${id(e.from)} -->${e.label ? `|${e.label}|` : ''} ${id(e.to)}`).join('\n') + '\n```';
  }
  return [doc.title, '='.repeat(doc.title.length), ...doc.sections.flatMap((s) => ['', `[${s.heading}]`, ...s.lines])].join('\n') + '\n';
}

/** `--check`: committed docs/generated/*.txt must equal what the code produces now. Returns the kinds that drifted. */
export function check(root: string, write = false): string[] {
  const bad: string[] = [];
  const dir = join(root, 'docs', 'generated');
  for (const a of ARCH) if (!existsSync(join(root, a.dir))) bad.push(`arch: listed folder missing: ${a.dir}`);
  const listed = new Set<string>(ARCH.map((a) => a.dir));
  if (existsSync(join(root, 'src'))) for (const d of readdirSync(join(root, 'src'), { withFileTypes: true })) if (d.isDirectory() && !listed.has(`src/${d.name}`)) bad.push(`arch: src/${d.name} is not in the diagram`);
  for (const k of ['arch', 'data', 'stages', 'routing'] as const) {
    const text = render(build(k), 'ascii'), file = join(dir, `${k}.txt`);
    if (write) { mkdirSync(dir, { recursive: true }); writeFileSync(file, text, 'utf8'); continue; }
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) bad.push(`${k}: docs/generated/${k}.txt is out of date (run: hub diagram --write)`);
  }
  return bad;
}
export { REPO_ROOT };
