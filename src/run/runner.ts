import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { startAgent, type RunHandle } from '../adapters/process.ts';
import type { AgentAdapter, HubEvent, Permission } from '../adapters/types.ts';
import type { AgentId } from '../core/types.ts';
import { addLimit, projectId, tx, type Db } from '../history/store.ts';
import { HUB_HOME } from '../core/registry.ts';
import { redact } from '../lib/redact.ts';
import { createWorktree, isGitRepo, pushGuardEnv } from './git.ts';
import { leanArgs } from './lean.ts';
import { handoffPrompt, writeCard, type Card, type HandoffInput } from './handoff.ts';
import { readRunnerHooks, runHooks } from './hooks-run.ts';
import { modelSummary, type Summary } from './summarize.ts';

export interface StartReq {
  agent: AgentId; prompt: string; projectRoot: string; task?: string; model?: string; effort?: string; permission?: Permission;
  resumeRunId?: string; resumeNativeId?: string; resumeOfSession?: string; worktree?: boolean; sparse?: string[]; handoffOf?: string; mode?: 'chat' | 'task';
  cls?: string; workMode?: string; est?: unknown;          // task class and the estimate shown to the user, kept to compare with the actual
}
export interface RunRow { id: string; agent: string; model: string | null; effort: string | null; prompt: string | null; cwd: string | null; branch: string | null; startedAt: string; endedAt: string | null; outcome: string | null; sessionNativeId: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; handoffOf: string | null; resumeOf: string | null; error: string | null; projectId: number | null; tokensCached: number | null; cls: string | null; estJson: string | null; rating: number | null; projectType: string | null; permission: string | null; workMode: string | null }
export interface StoredEvent { seq: number; ts: string; kind: string; data: unknown }

const COLS = 'id, agent, model, effort, prompt, cwd, branch, started_at AS startedAt, ended_at AS endedAt, outcome, session_native_id AS sessionNativeId, tokens_in AS tokensIn, tokens_out AS tokensOut, cost_usd AS costUsd, handoff_of AS handoffOf, resume_of AS resumeOf, error, project_id AS projectId, tokens_cached AS tokensCached, cls, est_json AS estJson, rating, project_type AS projectType, permission, work_mode AS workMode';
const MAX_CONCURRENT = 4;
const MAX_KEEP = 400;

/** `summarize`: false = deterministic handoff summary only; a function replaces the model call (tests). Default: try the cheap model, fall back. */
export interface RunManagerOpts { exe?: Partial<Record<AgentId, { cmd: string; prefix: string[] }>>; env?: NodeJS.ProcessEnv; summarize?: boolean | ((inp: HandoffInput) => Promise<Summary | undefined>); home?: string }

const projectTypeOf = (root: string): string | null => { try { return (JSON.parse(readFileSync(join(root, 'hub.json'), 'utf8')) as { project?: { type?: string } }).project?.type ?? null; } catch { return null; } };

export class RunManager {
  readonly adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter };
  private live = new Map<string, { handle: RunHandle; stopped: boolean }>();
  private subs = new Map<string, Set<(e: StoredEvent) => void>>();
  private db: Db;
  private opts: RunManagerOpts;
  constructor(db: Db, opts: RunManagerOpts = {}) {
    this.db = db; this.opts = opts;
    // A crashed server leaves rows without an end: mark them so the UI never shows a ghost "running" run.
    db.prepare("UPDATE run SET outcome = 'interrupted', ended_at = ? WHERE outcome IS NULL").run(new Date().toISOString());
  }

  start(req: StartReq): RunRow {
    if (!isAbsolute(req.projectRoot) || !existsSync(req.projectRoot) || !statSync(req.projectRoot).isDirectory()) throw new Error(`project folder not found: ${req.projectRoot}`);
    if (!req.prompt.trim()) throw new Error('empty prompt');
    if (this.live.size >= MAX_CONCURRENT) throw new Error(`too many concurrent runs (max ${MAX_CONCURRENT})`);
    const adapter = this.adapters[req.agent];
    if (!adapter) throw new Error(`unknown agent: ${req.agent}`);
    const id = `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

    let cwd = req.projectRoot, branch: string | null = null, resumeId: string | undefined, baseSha: string | undefined, prevPerm: string | null = null, prevMode: string | null = null;
    if (req.resumeRunId) {
      const prev = this.get(req.resumeRunId);
      if (!prev?.sessionNativeId) throw new Error('nothing to resume: the previous run has no session id');
      if (prev.agent !== req.agent) throw new Error('resume works inside one agent; use handoff to switch agents');
      resumeId = prev.sessionNativeId; cwd = prev.cwd ?? cwd; branch = prev.branch; prevPerm = prev.permission; prevMode = prev.workMode;
    } else if (req.resumeNativeId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,79}$/.test(req.resumeNativeId)) throw new Error('session id has an unexpected shape; not resuming');
      resumeId = req.resumeNativeId;
    } else if (req.handoffOf) {
      const prev = this.get(req.handoffOf);
      if (prev?.cwd) { cwd = prev.cwd; branch = prev.branch; }
    } else if (req.worktree ?? req.mode === 'task') {
      if (!isGitRepo(req.projectRoot)) throw new Error('worktree needs a git repository');
      const wt = createWorktree(req.projectRoot, req.task ?? id, req.agent, { ...(req.sparse ? { sparse: req.sparse } : {}) });
      cwd = wt.path; branch = wt.branch; baseSha = wt.baseSha;
    }
    // A resumed thread keeps the permission it had unless the user chose another one; a review thread never leaves plan.
    const permission: Permission = prevMode === 'review' ? 'plan' : req.permission ?? (prevPerm === 'plan' || prevPerm === 'full' || prevPerm === 'edit' ? prevPerm : 'edit');
    const workMode = req.workMode ?? prevMode;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO run (id, project_id, agent, model, effort, prompt, cwd, branch, started_at, handoff_of, resume_of, cls, est_json, project_type, permission, work_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId(this.db, req.projectRoot), req.agent, req.model ?? null, req.effort ?? null, redact(req.prompt).slice(0, 20_000), cwd, branch, new Date().toISOString(), req.handoffOf ?? null, req.resumeRunId ?? (req.resumeOfSession ? `session:${req.resumeOfSession}` : null), req.cls ?? null, req.est ? JSON.stringify(req.est) : null, projectTypeOf(req.projectRoot), permission, workMode);
    });

    const events: HubEvent[] = [];
    let seq = 0, limit: Extract<HubEvent, { kind: 'limit' }> | undefined, tokIn = 0, tokOut = 0, cost = 0, cached = 0;
    const emit = (e: HubEvent): void => {
      if (e.kind === 'limit' && e.reached && limit) return;   // Codex reports the same limit as `error` and `turn.failed`: keep one
      const row: StoredEvent = { seq: ++seq, ts: new Date().toISOString(), kind: e.kind, data: e };
      this.db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, row.seq, row.ts, e.kind, JSON.stringify(e));
      if (events.length < MAX_KEEP) events.push(e); else { events.shift(); events.push(e); }
      if (e.kind === 'session') { this.db.prepare('UPDATE run SET session_native_id = ?, model = COALESCE(model, ?) WHERE id = ?').run(e.nativeId, e.model ?? null, id); }
      if (e.kind === 'usage') { tokIn += e.uncachedIn + e.cachedIn; cached += e.cachedIn; tokOut += e.out; cost += e.costUsd ?? 0; this.db.prepare('UPDATE run SET tokens_in = ?, tokens_cached = ?, tokens_out = ?, cost_usd = ? WHERE id = ?').run(tokIn, cached, tokOut, cost || null, id); }
      if (e.kind === 'limit') {
        if (e.reached) limit = e;
        if (e.usedPercent != null) addLimit(this.db, { agent: req.agent, ts: row.ts, windowMinutes: null, usedPercent: e.usedPercent, resetsAt: e.resetsAt ? Math.floor(Date.parse(e.resetsAt) / 1000) : null, planType: null, source: 'cli-event' });
      }
      if (e.kind === 'error') this.db.prepare('UPDATE run SET error = ? WHERE id = ?').run(e.message.slice(0, 500), id);
      this.subs.get(id)?.forEach((cb) => cb(row));
    };

    const home = this.opts.home ?? HUB_HOME;
    const env = pushGuardEnv(home, this.opts.env ?? process.env);
    const hooks = readRunnerHooks(req.projectRoot, home);
    if (!hooks.approved) { emit({ kind: 'warn', message: 'hub.json has runner hooks that you have not approved on this machine: skipped. Review and approve with `hub hooks --approve <project>`.' }); hooks.sessionStart = []; hooks.sessionEnd = []; }
    const note = (r: { event: string; command: string; code: number | null; output: string }[]): void => r.forEach((h) => emit({ kind: 'warn', message: `hook ${h.event}: ${h.command} → ${h.code === 0 ? 'ok' : 'exit ' + h.code}${h.output ? ' · ' + h.output.slice(0, 120) : ''}` }));
    note(runHooks('sessionStart', hooks.sessionStart, cwd, { ...env, HUB_RUN_ID: id, HUB_AGENT: req.agent }));
    const exe = this.opts.exe?.[req.agent];
    const handle = startAgent(adapter, { prompt: req.prompt, cwd, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(resumeId ? { resumeId } : {}), permission, lean: leanArgs(req.agent, req.cls, { projectRoot: req.projectRoot, cwd }) }, emit,
      { env, ...(exe ? { exe } : {}) });
    const entry = { handle, stopped: false };
    this.live.set(id, entry);
    void handle.done.then(async () => {
      this.live.delete(id);
      const outcome = limit ? 'limit' : entry.stopped ? 'stopped' : events.some((e) => e.kind === 'error') || !events.some((e) => e.kind === 'done' && e.ok) ? 'failed' : 'done';
      this.db.prepare('UPDATE run SET outcome = ?, ended_at = ? WHERE id = ?').run(outcome, new Date().toISOString(), id);
      if (outcome === 'limit' && limit) {
        try {
          const inp: HandoffInput = { runId: id, task: req.task ?? 'chat', prompt: req.prompt, from: { agent: req.agent, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) }, reason: 'limit_reached', cwd, events, ...(baseSha ? { baseSha } : {}), ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) };
          const sum = await this.summarize(inp);
          const card = sum ? writeCard(join(req.projectRoot, '.hub'), inp, sum, 'claude-haiku-5-5') : writeCard(join(req.projectRoot, '.hub'), inp);
          emit({ kind: 'warn', message: `handoff_ready:${card.path}` });
          this.db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, ++seq, new Date().toISOString(), 'handoff', JSON.stringify({ path: card.path, id: card.id, branch: card.facts.branch, files: card.facts.changed.length, committed: card.facts.committed, resetsAt: limit.resetsAt ?? null }));
          this.subs.get(id)?.forEach((cb) => cb({ seq, ts: new Date().toISOString(), kind: 'handoff', data: { path: card.path, id: card.id } }));
        } catch (e) { emit({ kind: 'error', message: `could not write handoff card: ${(e as Error).message}` }); }
      }
      note(runHooks('sessionEnd', hooks.sessionEnd, cwd, { ...env, HUB_RUN_ID: id, HUB_AGENT: req.agent, HUB_OUTCOME: outcome }));
      const endRow: StoredEvent = { seq: ++seq, ts: new Date().toISOString(), kind: 'end', data: { outcome } };
      this.db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, endRow.seq, endRow.ts, 'end', JSON.stringify(endRow.data));
      this.subs.get(id)?.forEach((cb) => cb(endRow));
    });
    return this.get(id) as RunRow;
  }

  private async summarize(inp: HandoffInput): Promise<Summary | undefined> {
    const s = this.opts.summarize;
    if (s === false) return undefined;
    if (typeof s === 'function') return s(inp).catch(() => undefined);
    const exe = this.opts.exe?.claude;
    return modelSummary(inp, { ...(exe ? { exe } : {}), ...(this.opts.env ? { env: this.opts.env } : {}) }).catch(() => undefined);
  }

  stop(id: string): boolean { const r = this.live.get(id); if (!r) return false; r.stopped = true; r.handle.stop(); return true; }
  isLive = (id: string): boolean => this.live.has(id);

  get(id: string): RunRow | undefined { return this.db.prepare(`SELECT ${COLS} FROM run WHERE id = ?`).get(id) as unknown as RunRow | undefined; }
  list(f: { projectId?: number; limit?: number } = {}): RunRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM run ${f.projectId != null ? 'WHERE project_id = ?' : ''} ORDER BY started_at DESC LIMIT ?`).all(...(f.projectId != null ? [f.projectId] : []), f.limit ?? 50) as unknown as RunRow[];
  }
  events(id: string, afterSeq = 0): StoredEvent[] {
    return (this.db.prepare('SELECT seq, ts, kind, data FROM run_event WHERE run_id = ? AND seq > ? ORDER BY seq').all(id, afterSeq) as unknown as { seq: number; ts: string; kind: string; data: string }[]).map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }
  subscribe(id: string, cb: (e: StoredEvent) => void): () => void {
    let s = this.subs.get(id); if (!s) this.subs.set(id, (s = new Set()));
    s.add(cb);
    return () => { s?.delete(cb); };
  }

  handoffCard(runId: string): { path: string; markdown: string; branch: string; resetsAt: string | null } | undefined {
    const ev = this.events(runId).filter((e) => e.kind === 'handoff').at(-1);
    if (!ev) return undefined;
    const d = ev.data as { path: string; branch: string; resetsAt: string | null };
    return existsSync(d.path) ? { path: d.path, markdown: readFileSync(d.path, 'utf8'), branch: d.branch, resetsAt: d.resetsAt } : undefined;
  }

  /** Continue a stopped run on another agent in the same folder/branch, starting from its handoff card (not its transcript). */
  handoff(runId: string, to: { agent: AgentId; model?: string; effort?: string; permission?: Permission }): RunRow {
    const prev = this.get(runId);
    if (!prev) throw new Error('run not found');
    const card = this.handoffCard(runId);
    if (!card) throw new Error('this run has no handoff card (it did not stop on a limit)');
    const root = prev.cwd ?? '';
    const projectRoot = (this.db.prepare('SELECT root FROM project WHERE id = ?').get(prev.projectId) as { root: string } | undefined)?.root ?? root;
    const c = { markdown: card.markdown, facts: { branch: card.branch } } as unknown as Card;
    const prevPerm = prev.workMode === 'review' ? 'plan' : prev.permission === 'plan' || prev.permission === 'full' || prev.permission === 'edit' ? prev.permission : undefined;
    return this.start({ agent: to.agent, prompt: handoffPrompt(c, prev.prompt ?? ''), projectRoot: existsSync(projectRoot) ? projectRoot : root, handoffOf: runId, task: 'handoff', ...(to.model ? { model: to.model } : {}), ...(to.effort ? { effort: to.effort } : {}), ...(to.permission ?? prevPerm ? { permission: (to.permission ?? prevPerm) as Permission } : {}), ...(prev.workMode ? { workMode: prev.workMode } : {}) });
  }
}
