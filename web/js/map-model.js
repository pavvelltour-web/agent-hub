// Pure model of the orchestrator map (ADR-027): the layout of the tree and a few helpers. No DOM here, so it is tested in Node (src/server/map-model.test.ts).

const GAP_X = 28, GAP_Y = 76, PAD = 24;
const SIZES = { card: { w: 232, h: 148 }, sub: { w: 204, h: 124 }, pill: { w: 204, h: 68 } };

/** Box size by node kind: runs are cards, sub-agents are smaller cards, background things are pills. */
export const sizeOf = (kind) => (kind === 'subagent' ? SIZES.sub : kind === 'background' || kind === 'hubjob' || kind === 'mcp' ? SIZES.pill : SIZES.card);

/**
 * Top-down tree. Siblings keep the order they came in, a parent is centred over its children, roots sit side by side, every level has the height of its tallest node.
 * Defensive: an edge to an unknown node is ignored, a duplicate id is dropped, a cycle terminates (each node is placed once).
 */
export function layout(map) {
  const nodes = [], seen = new Set();
  for (const n of Array.isArray(map?.nodes) ? map.nodes : []) if (n && typeof n.id === 'string' && !seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map(), hasParent = new Set();
  for (const e of Array.isArray(map?.edges) ? map.edges : []) {
    if (!e || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to || hasParent.has(e.to)) continue;
    hasParent.add(e.to);
    (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)).push(e.to);
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  const placed = new Set(), depth = new Map(), width = new Map(), order = [];
  const measure = (id, d, trail) => {   // subtree width and depth; `trail` guards a cycle
    placed.add(id); depth.set(id, d); order.push(id);
    const sz = sizeOf(byId.get(id).kind);
    const cs = (kids.get(id) ?? []).filter((c) => !placed.has(c) && !trail.has(c));
    let w = 0;
    for (const c of cs) w += measure(c, d + 1, new Set([...trail, id])) + (w ? GAP_X : 0);
    width.set(id, Math.max(sz.w, w)); kids.set(id, cs);
    return width.get(id);
  };
  const tops = roots.length ? roots : [nodes[0].id];
  for (const r of tops) if (!placed.has(r)) measure(r, 0, new Set());
  for (const n of nodes) if (!placed.has(n.id)) { tops.push(n.id); measure(n.id, 0, new Set()); }   // anything left over (a cycle) gets its own root

  const levelH = [];
  for (const [id, d] of depth) levelH[d] = Math.max(levelH[d] ?? 0, sizeOf(byId.get(id).kind).h);
  const levelY = []; let y = PAD;
  for (let d = 0; d < levelH.length; d++) { levelY[d] = y; y += levelH[d] + GAP_Y; }
  const pos = new Map();
  const place = (id, left) => {
    const sz = sizeOf(byId.get(id).kind), span = width.get(id), cs = kids.get(id) ?? [];
    pos.set(id, { x: left + (span - sz.w) / 2, y: levelY[depth.get(id)] });
    let x = left + (span - cs.reduce((a, c, i) => a + width.get(c) + (i ? GAP_X : 0), 0)) / 2;
    for (const c of cs) { place(c, x); x += width.get(c) + GAP_X; }
  };
  let left = PAD;
  for (const r of tops) { place(r, left); left += width.get(r) + GAP_X * 2; }

  const out = nodes.map((n) => ({ ...n, ...sizeOf(n.kind), x: pos.get(n.id).x, y: pos.get(n.id).y }));
  const at = new Map(out.map((n) => [n.id, n]));
  const edges = [];
  for (const [from, cs] of kids) for (const to of cs) {
    const p = at.get(from), c = at.get(to), e = (map.edges ?? []).find((x) => x.from === from && x.to === to);
    const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = c.x + c.w / 2, y2 = c.y, k = Math.max(24, (y2 - y1) / 2);
    // The label sits at 70 % of the curve, nearer the child, where sibling edges are furthest apart (at the middle they all pass close to the same point).
    const t = 0.7, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, cc = 3 * (1 - t) * t ** 2, dd = t ** 3;
    edges.push({ from, to, reason: String(e?.reason ?? ''), d: `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`, lx: x1 * (a + b) + x2 * (cc + dd), ly: y1 * a + (y1 + k) * b + (y2 - k) * cc + y2 * dd });
  }
  return { nodes: out, edges, width: Math.max(...out.map((n) => n.x + n.w)) + PAD, height: Math.max(...out.map((n) => n.y + n.h)) + PAD };
}

/** Share of the context limit used, 0-100, or null when it was not measured. */
export const contextPct = (c) => (c && Number.isFinite(c.used) && Number.isFinite(c.limit) && c.limit > 0 ? Math.min(100, Math.max(0, Math.round((c.used / c.limit) * 100))) : null);

const TONES = { running: 'info', done: 'ok', failed: 'err', stopped: 'warn', unfinished: 'warn', unknown: 'line' };
export const statusTone = (s) => TONES[s] ?? 'line';
const STATUS_RU = { running: 'работает', done: 'готово', failed: 'ошибка', stopped: 'остановлен', unfinished: 'не завершён', unknown: 'неизвестно' };
export const statusLabel = (s) => STATUS_RU[s] ?? 'неизвестно';
const KIND_RU = { orchestrator: 'Оркестратор', run: 'Запуск', subagent: 'Субагент', background: 'Фоновый процесс', hubjob: 'Задача hub', mcp: 'MCP-сервер' };
export const kindLabel = (k) => KIND_RU[k] ?? 'Узел';

const REASON_RU = { 'started by you': 'запущено вами', 'handoff: limit': 'передача: кончился лимит', 'handoff: context 250K': 'передача: контекст 250K', handoff: 'передача другому агенту', 'follow-up message': 'ваше сообщение',
  'repair after failed verify': 'правка после красной проверки', 'review hunter': 'ревью: поиск ошибок', 'review verifier': 'ревью: проверка находки', 'native sub-agent': 'субагент', 'background shell': 'фоновый процесс',
  'hub background job': 'фоновая задача hub', 'spawned for another run': 'запущен для другого запуска' };
/** The reason an edge exists, in Russian for the panel; an unknown reason is shown as it came (it is data, drawn as text). */
export const reasonLabel = (r) => {
  const s = String(r ?? '');
  if (REASON_RU[s]) return REASON_RU[s];
  const m = /^(escalation after failed verify|native sub-agent): (.+)$/.exec(s);
  return m ? `${m[1] === 'native sub-agent' ? 'субагент' : 'эскалация после красной проверки'}: ${m[2]}` : s;
};

/** Ids of nodes that were running in `prev` ({id: status}) and are not any more: the view lets them "settle". */
export const changedToDone = (prev, nodes) => nodes.filter((n) => prev[n.id] === 'running' && n.status !== 'running').map((n) => n.id);
