import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HUB_HOME } from '../core/registry.ts';
import { norm, pathKey } from '../lib/paths.ts';

export type Db = DatabaseSync;
export const defaultDbPath = (): string => `${HUB_HOME}/hub.sqlite`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, root TEXT NOT NULL, slug TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, native_id TEXT NOT NULL, project_id INTEGER REFERENCES project(id), parent_id TEXT,
  title TEXT, model TEXT, effort TEXT, started_at TEXT, ended_at TEXT, source_kind TEXT NOT NULL, source_path TEXT NOT NULL,
  uncached_in INTEGER NOT NULL DEFAULT 0, cached_in INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, msg_count INTEGER NOT NULL DEFAULT 0,
  origin TEXT, UNIQUE (agent, native_id));
CREATE TABLE IF NOT EXISTS message (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), ordinal INTEGER NOT NULL, role TEXT NOT NULL, ts TEXT, tool_name TEXT, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS message_session ON message(session_id, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(text, content='message', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS usage_event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT, model TEXT, uncached_in INTEGER, cached_in INTEGER, out_tokens INTEGER, reasoning INTEGER);
CREATE INDEX IF NOT EXISTS usage_ts ON usage_event(ts);
CREATE TABLE IF NOT EXISTS limit_snapshot (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, ts TEXT NOT NULL, window_minutes INTEGER, used_percent REAL, resets_at INTEGER, plan_type TEXT, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS limit_agent_ts ON limit_snapshot(agent, ts);
CREATE TABLE IF NOT EXISTS source_file_state (path TEXT PRIMARY KEY, size INTEGER, mtime_ms INTEGER, byte_offset INTEGER NOT NULL DEFAULT 0, last_ordinal INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, project_id INTEGER, agent TEXT NOT NULL, model TEXT, effort TEXT, prompt TEXT, cwd TEXT, branch TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, session_native_id TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, handoff_of TEXT, error TEXT, resume_of TEXT, tokens_cached INTEGER, cls TEXT, est_json TEXT, rating INTEGER, project_type TEXT);
CREATE TABLE IF NOT EXISTS run_event (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS run_event_run ON run_event(run_id, seq);
`;

export function openDb(path = defaultDbPath()): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  // Older databases lack columns added later: add them in place (never drop data).
  const have = new Set((db.prepare('PRAGMA table_info(run)').all() as unknown as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [['resume_of', 'TEXT'], ['tokens_cached', 'INTEGER'], ['cls', 'TEXT'], ['est_json', 'TEXT'], ['rating', 'INTEGER'], ['project_type', 'TEXT']] as const) if (!have.has(col)) db.exec(`ALTER TABLE run ADD COLUMN ${col} ${type}`);
  return db;
}

export const tx = <T>(db: Db, fn: () => T): T => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

/** Worktree folders belong to their main project: `X-worktrees/<n>` and `X/.claude/worktrees/<n>` map to X. */
export function projectRoot(cwd: string): string {
  const p = norm(cwd);
  const m1 = /^(.*?)-worktrees\/[^/]+(?:\/.*)?$/.exec(p);
  if (m1?.[1]) return m1[1];
  const m2 = /^(.*?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(p);
  return m2?.[1] ?? p;
}

export function projectId(db: Db, cwd: string | null | undefined): number | null {
  if (!cwd) return null;
  const root = projectRoot(cwd);
  const key = pathKey(root);
  const row = db.prepare('SELECT id FROM project WHERE key = ?').get(key) as { id: number } | undefined;
  if (row) return row.id;
  const slug = root.split('/').filter(Boolean).pop() ?? root;
  return Number(db.prepare('INSERT INTO project (key, root, slug) VALUES (?, ?, ?)').run(key, root, slug).lastInsertRowid);
}

export interface SessionRow {
  id: string; agent: 'claude' | 'codex'; nativeId: string; cwd?: string | null; parentId?: string | null; title?: string | null; model?: string | null; effort?: string | null;
  startedAt?: string | null; endedAt?: string | null; sourceKind: string; sourcePath: string; origin?: string | null;
}

export function upsertSession(db: Db, s: SessionRow): void {
  const pid = projectId(db, s.cwd);
  db.prepare(`INSERT INTO session (id, agent, native_id, project_id, parent_id, title, model, effort, started_at, ended_at, source_kind, source_path, origin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET project_id=COALESCE(excluded.project_id, project_id), parent_id=COALESCE(excluded.parent_id, parent_id),
      title=COALESCE(excluded.title, title), model=COALESCE(excluded.model, model), effort=COALESCE(excluded.effort, effort),
      started_at=COALESCE(started_at, excluded.started_at), ended_at=COALESCE(excluded.ended_at, ended_at), origin=COALESCE(excluded.origin, origin)`)
    .run(s.id, s.agent, s.nativeId, pid, s.parentId ?? null, s.title ?? null, s.model ?? null, s.effort ?? null, s.startedAt ?? null, s.endedAt ?? null, s.sourceKind, s.sourcePath, s.origin ?? null);
}

/** Forget everything imported for a session (used when its source file was rewritten, not appended). */
export function resetSession(db: Db, id: string): void {
  db.prepare('DELETE FROM message_fts WHERE rowid IN (SELECT id FROM message WHERE session_id = ?)').run(id);
  db.prepare('DELETE FROM message WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM usage_event WHERE session_id = ?').run(id);
  db.prepare('UPDATE session SET msg_count = 0, uncached_in = 0, cached_in = 0, out_tokens = 0 WHERE id = ?').run(id);
}

export function addMessage(db: Db, sessionId: string, ordinal: number, role: string, ts: string | null, text: string, toolName: string | null = null): void {
  const id = Number(db.prepare('INSERT INTO message (session_id, ordinal, role, ts, tool_name, text) VALUES (?,?,?,?,?,?)').run(sessionId, ordinal, role, ts, toolName, text).lastInsertRowid);
  db.prepare('INSERT INTO message_fts (rowid, text) VALUES (?, ?)').run(id, text);
  db.prepare('UPDATE session SET msg_count = msg_count + 1 WHERE id = ?').run(sessionId);
}

export function addUsage(db: Db, sessionId: string, ts: string | null, model: string | null, u: { uncachedIn: number; cachedIn: number; out: number; reasoning?: number }): void {
  db.prepare('INSERT INTO usage_event (session_id, ts, model, uncached_in, cached_in, out_tokens, reasoning) VALUES (?,?,?,?,?,?,?)').run(sessionId, ts, model, u.uncachedIn, u.cachedIn, u.out, u.reasoning ?? 0);
  db.prepare('UPDATE session SET uncached_in = uncached_in + ?, cached_in = cached_in + ?, out_tokens = out_tokens + ? WHERE id = ?').run(u.uncachedIn, u.cachedIn, u.out, sessionId);
}

export interface FileState { size: number; mtimeMs: number; byteOffset: number; lastOrdinal: number }
export const getState = (db: Db, path: string): FileState | undefined => {
  const r = db.prepare('SELECT size, mtime_ms, byte_offset, last_ordinal FROM source_file_state WHERE path = ?').get(path) as { size: number; mtime_ms: number; byte_offset: number; last_ordinal: number } | undefined;
  return r ? { size: r.size, mtimeMs: r.mtime_ms, byteOffset: r.byte_offset, lastOrdinal: r.last_ordinal } : undefined;
};
export const setState = (db: Db, path: string, s: FileState): void => {
  db.prepare('INSERT INTO source_file_state (path, size, mtime_ms, byte_offset, last_ordinal) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, byte_offset=excluded.byte_offset, last_ordinal=excluded.last_ordinal')
    .run(path, s.size, s.mtimeMs, s.byteOffset, s.lastOrdinal);
};

// ---------- queries ----------
import { cleanTitle } from '../lib/title.ts';
export interface SessionListItem { id: string; agent: string; title: string | null; model: string | null; project: string | null; projectId: number | null; startedAt: string | null; endedAt: string | null; msgCount: number; tokens: number; parentId: string | null }
const SESS = 'SELECT s.id, s.agent, s.title, s.model, p.slug AS project, s.project_id AS projectId, s.started_at AS startedAt, s.ended_at AS endedAt, s.msg_count AS msgCount, (s.uncached_in + s.cached_in + s.out_tokens) AS tokens, s.parent_id AS parentId FROM session s LEFT JOIN project p ON p.id = s.project_id';

const tidy = <T extends { title?: unknown }>(r: T): T => ({ ...r, title: cleanTitle(typeof r.title === 'string' ? r.title : null) });

export function listSessions(db: Db, f: { projectId?: number; agent?: string; model?: string; q?: string; limit?: number; offset?: number; topLevel?: boolean } = {}): SessionListItem[] {
  const w: string[] = []; const a: (string | number)[] = [];
  if (f.projectId != null) { w.push('s.project_id = ?'); a.push(f.projectId); }
  if (f.agent) { w.push('s.agent = ?'); a.push(f.agent); }
  if (f.model) { w.push('s.model = ?'); a.push(f.model); }
  if (f.topLevel) w.push('s.parent_id IS NULL');
  if (f.q) { w.push('s.title LIKE ?'); a.push(`%${f.q}%`); }
  return db.prepare(`${SESS}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT ? OFFSET ?`).all(...a, f.limit ?? 50, f.offset ?? 0).map(tidy) as unknown as SessionListItem[];
}

export function getSession(db: Db, id: string, o: { limit?: number; offset?: number } = {}): { session: SessionListItem; messages: { ordinal: number; role: string; ts: string | null; toolName: string | null; text: string }[] } | undefined {
  const row = db.prepare(`${SESS} WHERE s.id = ?`).get(id) as unknown as SessionListItem | undefined;
  if (!row) return undefined;
  const session = tidy(row);
  const messages = db.prepare('SELECT ordinal, role, ts, tool_name AS toolName, text FROM message WHERE session_id = ? ORDER BY ordinal LIMIT ? OFFSET ?').all(id, o.limit ?? 200, o.offset ?? 0) as unknown as { ordinal: number; role: string; ts: string | null; toolName: string | null; text: string }[];
  return { session, messages };
}

export interface Hit { sessionId: string; agent: string; title: string | null; project: string | null; ordinal: number; role: string; snippet: string }
/** Full-text search. The query is quoted per token so user input can never inject FTS operators. */
export function search(db: Db, q: string, f: { projectId?: number; agent?: string; limit?: number } = {}): Hit[] {
  const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"*`).join(' ');
  const w = ['message_fts MATCH ?']; const a: (string | number)[] = [match];
  if (f.projectId != null) { w.push('s.project_id = ?'); a.push(f.projectId); }
  if (f.agent) { w.push('s.agent = ?'); a.push(f.agent); }
  return db.prepare(`SELECT s.id AS sessionId, s.agent, s.title, p.slug AS project, m.ordinal, m.role, snippet(message_fts, 0, '[', ']', '…', 14) AS snippet
    FROM message_fts JOIN message m ON m.id = message_fts.rowid JOIN session s ON s.id = m.session_id LEFT JOIN project p ON p.id = s.project_id
    WHERE ${w.join(' AND ')} ORDER BY rank LIMIT ?`).all(...a, f.limit ?? 30).map(tidy) as unknown as Hit[];
}

export interface ProjectItem { id: number; slug: string; root: string; sessions: number; claude: number; codex: number; lastAt: string | null; tokens: number }
export const listProjects = (db: Db): ProjectItem[] => db.prepare(`SELECT p.id, p.slug, p.root, COUNT(s.id) AS sessions, SUM(s.agent='claude') AS claude, SUM(s.agent='codex') AS codex,
  MAX(COALESCE(s.ended_at, s.started_at)) AS lastAt, COALESCE(SUM(s.uncached_in + s.cached_in + s.out_tokens),0) AS tokens
  FROM project p LEFT JOIN session s ON s.project_id = p.id AND s.parent_id IS NULL GROUP BY p.id ORDER BY lastAt IS NULL, lastAt DESC`).all() as unknown as ProjectItem[];

export interface ModelUsage { model: string; agent: string; sessions: number; uncachedIn: number; cachedIn: number; out: number }
export const usageByModel = (db: Db, sinceIso?: string): ModelUsage[] => db.prepare(`SELECT u.model, s.agent, COUNT(DISTINCT u.session_id) AS sessions, SUM(u.uncached_in) AS uncachedIn, SUM(u.cached_in) AS cachedIn, SUM(u.out_tokens) AS out
  FROM usage_event u JOIN session s ON s.id = u.session_id WHERE u.model IS NOT NULL AND u.model <> '' AND u.model NOT LIKE '<%' ${sinceIso ? 'AND u.ts >= ?' : ''} GROUP BY u.model, s.agent ORDER BY out DESC`).all(...(sinceIso ? [sinceIso] : [])) as unknown as ModelUsage[];

export interface LimitRow { agent: string; ts: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: number | null; planType: string | null; source: string }
export const latestLimit = (db: Db, agent: string): LimitRow | undefined => db.prepare('SELECT agent, ts, window_minutes AS windowMinutes, used_percent AS usedPercent, resets_at AS resetsAt, plan_type AS planType, source FROM limit_snapshot WHERE agent = ? ORDER BY ts DESC, id DESC LIMIT 1').get(agent) as unknown as LimitRow | undefined;

export const addLimit = (db: Db, l: Omit<LimitRow, 'ts'> & { ts: string }): void => {
  const last = latestLimit(db, l.agent);
  if (last && last.usedPercent === l.usedPercent && last.resetsAt === l.resetsAt && last.windowMinutes === l.windowMinutes) return;
  db.prepare('INSERT INTO limit_snapshot (agent, ts, window_minutes, used_percent, resets_at, plan_type, source) VALUES (?,?,?,?,?,?,?)').run(l.agent, l.ts, l.windowMinutes, l.usedPercent, l.resetsAt, l.planType, l.source);
};
