import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { startAgent, type RunHandle } from '../adapters/process.ts';
import type { AgentAdapter, HubEvent, Permission } from '../adapters/types.ts';
import type { AgentId, RegistryEntry } from '../core/types.ts';
import { loadWorkModes } from '../core/workmodes.ts';
import { addLimit, projectId, tx, type Db } from '../history/store.ts';
import { HUB_HOME } from '../core/registry.ts';
import { redact } from '../lib/redact.ts';
import { createWorktree, isGitRepo, pushGuardEnv } from './git.ts';
import { leanPlan } from './lean.ts';
import { handoffPrompt, writeCard, type Card, type HandoffInput } from './handoff.ts';
import { readRunnerHooks, runHooks } from './hooks-run.ts';
import { modelSummary, type Summary } from './summarize.ts';
import { sanitizeEvent } from '../adapters/event-utils.ts';

export interface StartReq {
  agent: AgentId; prompt: string; projectRoot: string; task?: string; model?: string; effort?: string; permission?: Permission;
  resumeRunId?: string; resumeNativeId?: string; resumeOfSession?: string; worktree?: boolean; sparse?: string[]; handoffOf?: string; mode?: 'chat' | 'task';
  extraArgs?: string[];                                      // INTERNAL only (review gate): appended to the CLI args; api.ts must never forward it from a request body
  isolatedCwd?: string;                                      // INTERNAL only (review gate): run in this empty folder, without project hooks or settings; api.ts must never forward it
  cls?: string; workMode?: string; est?: unknown;          // task class and the estimate shown to the user, kept to compare with the actual
}
export interface RunRow { id: string; agent: string; model: string | null; effort: string | null; prompt: string | null; cwd: string | null; branch: string | null; startedAt: string; endedAt: string | null; outcome: string | null; sessionNativeId: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; handoffOf: string | null; resumeOf: string | null; error: string | null; projectId: number | null; tokensCached: number | null; cls: string | null; estJson: string | null; rating: number | null; projectType: string | null; permission: string | null; workMode: string | null; baseSha: string | null; verifyPassed: number | null }
export interface StoredEvent { seq: number; ts: string; kind: string; data: unknown }

const COLS = 'id, agent, model, effort, prompt, cwd, branch, started_at AS startedAt, ended_at AS endedAt, outcome, session_native_id AS sessionNativeId, tokens_in AS tokensIn, tokens_out AS tokensOut, cost_usd AS costUsd, handoff_of AS handoffOf, resume_of AS resumeOf, error, project_id AS projectId, tokens_cached AS tokensCached, cls, est_json AS estJson, rating, project_type AS projectType, permission, work_mode AS workMode, base_sha AS baseSha, verify_passed AS verifyPassed';
const MAX_CONCURRENT = 4;
const MAX_KEEP = 400;
/** ADR-018: above this many prompt tokens in ONE model call a task run is stopped and continued in a fresh session from its handoff card. */
export const CONTEXT_LIMIT = 250_000;
/** A task gets at most this many sessions in a row stopped for context size (the original and two fresh ones); then the user continues by hand. */
const CONTEXT_CHAIN_MAX = 3;

/** `summarize`: false = deterministic handoff summary only; a function replaces the model call (tests). Default: try the cheap model, fall back. */
export interface RunManagerOpts { exe?: Partial<Record<AgentId, { cmd: string; prefix: string[] }>>; env?: NodeJS.ProcessEnv; summarize?: boolean | ((inp: HandoffInput) => Promise<Summary | undefined>); home?: string;
  /** Tests: where work modes and MCP server definitions come from (defaults: the repo's `modes/` and the hub library). */
  lean?: { modesDir?: string; catalog?: RegistryEntry[] };
  /** Prompt-token size that counts as a large context (default `CONTEXT_LIMIT`; 0 switches the watch off). */
  contextLimit?: number }

/** The hub's session token / cookie / approval secrets must never reach an agent process: only the user's browser may approve a review. */
const HUB_SECRET_ENV = /hub.*(?:token|cookie|session|secret)/i;
export const agentEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !HUB_SECRET_ENV.test(k)));

/**
 * `work_mode` of a review-gate reviewer run (started with `isolatedCwd`). Such runs are plumbing, not the user's work: they are left out of the
 * run lists (chats, tasks), of econ / model stats / routing, never write a handoff card and never run project hooks.
 */
export const REVIEWER_MODE = 'gate-reviewer';

const projectTypeOf = (root: string): string | null => { try { return (JSON.parse(readFileSync(join(root, 'hub.json'), 'utf8')) as { project?: { type?: string } }).project?.type ?? null; } catch { return null; } };

export class RunManager {
  readonly adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter };
  private live = new Map<string, { handle: RunHandle; stopped: boolean }>();
  private subs = new Map<string, Set<(e: StoredEvent) => void>>();
  private db: Db;
  private opts: RunManagerOpts;
  /** The hub home this manager uses (push-guard hook, approvals). */
  readonly home: string;
  constructor(db: Db, opts: RunManagerOpts = {}) {
    this.db = db; this.opts = opts; this.home = opts.home ?? HUB_HOME;
    // A crashed server leaves rows without an end: mark them so the UI never shows a ghost "running" run.
    db.prepare("UPDATE run SET outcome = 'interrupted', ended_at = ? WHERE outcome IS NULL").run(new Date().toISOString());
    // Review rounds are NOT touched here: a `hub run` / `hub chat` process on the same database must not open a round the panel is running.
    // The panel marks rounds cut off by a crash when it starts (server.ts).
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
      resumeId = prev.sessionNativeId; cwd = prev.cwd ?? cwd; branch = prev.branch; baseSha = prev.baseSha ?? undefined; prevPerm = prev.permission; prevMode = prev.workMode;
    } else if (req.resumeNativeId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,79}$/.test(req.resumeNativeId)) throw new Error('session id has an unexpected shape; not resuming');
      resumeId = req.resumeNativeId;
      // A History session may be a hub run: inherit from the run that owns this native id (a review there wins).
      const own = this.db.prepare("SELECT permission, work_mode AS workMode FROM run WHERE session_native_id = ? ORDER BY work_mode = 'review' DESC, started_at DESC LIMIT 1").get(resumeId) as { permission: string | null; workMode: string | null } | undefined;
      if (own) { prevPerm = own.permission; prevMode = own.workMode; }
    } else if (req.handoffOf) {
      const prev = this.get(req.handoffOf);
      if (prev?.cwd) { cwd = prev.cwd; branch = prev.branch; baseSha = prev.baseSha ?? undefined; }
    } else if (req.isolatedCwd) {
      if (!isAbsolute(req.isolatedCwd) || !existsSync(req.isolatedCwd)) throw new Error('isolated folder not found');
      cwd = req.isolatedCwd;
    } else if (req.worktree ?? req.mode === 'task') {
      if (!isGitRepo(req.projectRoot)) throw new Error('worktree needs a git repository');
      const wt = createWorktree(req.projectRoot, req.task ?? id, req.agent, { ...(req.sparse ? { sparse: req.sparse } : {}) });
      cwd = wt.path; branch = wt.branch; baseSha = wt.baseSha;
    }
    // A resumed thread keeps the permission it had unless the user chose another one; a review thread never leaves plan.
    const permission: Permission = prevMode === 'review' || req.workMode === 'review' ? 'plan' : req.permission ?? (prevPerm === 'plan' || prevPerm === 'full' || prevPerm === 'edit' ? prevPerm : 'edit');
    const reviewer = !!req.isolatedCwd;
    const workMode = reviewer ? REVIEWER_MODE : prevMode === 'review' ? 'review' : req.workMode ?? prevMode;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO run (id, project_id, agent, model, effort, prompt, cwd, branch, started_at, handoff_of, resume_of, cls, est_json, project_type, permission, work_mode, base_sha) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId(this.db, req.projectRoot), req.agent, req.model || null, req.effort ?? null, redact(req.prompt).slice(0, 20_000), cwd, branch, new Date().toISOString(), req.handoffOf ?? null, req.resumeRunId ?? (req.resumeOfSession ? `session:${req.resumeOfSession}` : null), req.cls ?? null, req.est ? JSON.stringify(req.est) : null, projectTypeOf(req.projectRoot), permission, workMode, baseSha ?? null);
    });

    // How many sessions of this chain were already stopped for context size (a fresh session after a context stop is `handoffOf` the stopped one).
    let ctxDepth = 0;
    for (let p = req.handoffOf ? this.get(req.handoffOf) : undefined; p?.outcome === 'context' && ctxDepth < CONTEXT_CHAIN_MAX; p = p.handoffOf ? this.get(p.handoffOf) : undefined) ctxDepth++;
    const ctxLimit = this.opts.contextLimit ?? CONTEXT_LIMIT, ctxCapped = ctxDepth + 1 >= CONTEXT_CHAIN_MAX;
    let ctxWarned = false, ctxStop = false;
    const events: HubEvent[] = [];
    let seq = 0, limit: Extract<HubEvent, { kind: 'limit' }> | undefined, tokIn = 0, tokOut = 0, cost = 0, cached = 0;
    const emit = (raw: HubEvent): void => {
      const e = sanitizeEvent(raw);
      if (e.kind === 'limit' && e.reached && limit) return;   // Codex reports the same limit as `error` and `turn.failed`: keep one
      if (ctxStop && e.kind === 'warn' && e.message === 'stopped by user') return;   // the hub stopped it, the user did not
      if (e.kind === 'context') {
        // Per-call prompt size: watched, never stored or shown. A run in a hub task folder is stopped and continued from a card; a chat in the user's own folder is only warned.
        if (ctxLimit > 0 && e.tokens > ctxLimit && !ctxWarned) {
          ctxWarned = true;
          if (branch && !req.isolatedCwd) { ctxStop = true; emit({ kind: 'warn', message: ctxCapped ? 'контекст большой, и это уже три сессии подряд: остановил, продолжите вручную по карточке' : 'контекст большой: начну новую сессию по карточке' }); this.stop(id); }
          else emit({ kind: 'warn', message: `контекст большой (${Math.round(e.tokens / 1000)} тыс.): лучше начать новый чат, так дешевле` });
        }
        return;
      }
      const row: StoredEvent = { seq: ++seq, ts: new Date().toISOString(), kind: e.kind, data: e };
      // Live text deltas are shown but never stored: a secret split across two deltas cannot be redacted per piece, and the
      // final `text` event (redacted whole) is the record. The gap in `seq` is harmless for replay (`seq > after`).
      if (e.kind === 'partial') { this.subs.get(id)?.forEach((cb) => cb(row)); return; }
      this.db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, row.seq, row.ts, e.kind, JSON.stringify(e));
      const kept = e.kind === 'tool_result' ? { ...e, body: '' } : e.kind === 'tool' ? { ...e, input: {} } : e;   // handoff/summaries read summaries only: keep RAM small
      if (events.length < MAX_KEEP) events.push(kept); else { events.shift(); events.push(kept); }
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
    const env = pushGuardEnv(home, agentEnv(this.opts.env ?? process.env));
    const hooks: ReturnType<typeof readRunnerHooks> = req.isolatedCwd ? { approved: true, sessionStart: [], sessionEnd: [] } : readRunnerHooks(req.projectRoot, home);
    if (!hooks.approved) { emit({ kind: 'warn', message: 'hub.json has runner hooks that you have not approved on this machine: skipped. Review and approve with `hub hooks --approve <project>`.' }); hooks.sessionStart = []; hooks.sessionEnd = []; }
    const note = (r: { event: string; command: string; code: number | null; output: string }[]): void => r.forEach((h) => emit({ kind: 'warn', message: `hook ${h.event}: ${h.command} → ${h.code === 0 ? 'ok' : 'exit ' + h.code}${h.output ? ' · ' + h.output.slice(0, 120) : ''}` }));
    note(runHooks('sessionStart', hooks.sessionStart, cwd, { ...env, HUB_RUN_ID: id, HUB_AGENT: req.agent }));
    const exe = this.opts.exe?.[req.agent];
    // Tool set for this run: skills and MCP servers follow the work mode (a mode that lists none starts none). The temp MCP file lives in the hub's own folder.
    let mode; try { mode = reviewer || !workMode ? undefined : loadWorkModes(this.opts.lean?.modesDir).find((m) => m.id === workMode); } catch { mode = undefined; }
    const lean = reviewer ? undefined : leanPlan(req.agent, mode, { projectRoot: req.projectRoot, cwd, mcpNeeded: mode?.mcp ?? [], ...(req.cls ? { cls: req.cls } : {}), tmpDir: join(home, 'tmp'), ...(this.opts.lean?.catalog ? { catalog: this.opts.lean.catalog } : {}) });
    lean?.notes.forEach((message) => emit({ kind: 'warn', message }));
    const handle = startAgent(adapter, { prompt: req.prompt, cwd, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(resumeId ? { resumeId } : {}), permission, lean: lean?.args ?? [], ...(req.extraArgs?.length ? { extraArgs: req.extraArgs } : {}) }, emit,
      { env, ...(exe ? { exe } : {}) });
    const entry = { handle, stopped: false };
    this.live.set(id, entry);
    /** Commit a checkpoint, write the handoff card (reason as given) and record it on the run. false = the card could not be written. */
    const handover = async (reason: HandoffInput['reason'], resetsAt?: string): Promise<boolean> => {
      try {
        const inp: HandoffInput = { runId: id, task: req.task ?? 'chat', prompt: req.prompt, from: { agent: req.agent, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) }, reason, cwd, events, ...(baseSha ? { baseSha } : {}), ...(resetsAt ? { resetsAt } : {}) };
        const sum = await this.summarize(inp);
        const card = sum ? writeCard(join(req.projectRoot, '.hub'), inp, sum, 'claude-haiku-5-5') : writeCard(join(req.projectRoot, '.hub'), inp);
        emit({ kind: 'warn', message: `handoff_ready:${card.path}` });
        this.db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, ++seq, new Date().toISOString(), 'handoff', JSON.stringify({ path: card.path, id: card.id, branch: card.facts.branch, files: card.facts.changed.length, committed: card.facts.committed, resetsAt: resetsAt ?? null }));
        this.subs.get(id)?.forEach((cb) => cb({ seq, ts: new Date().toISOString(), kind: 'handoff', data: { path: card.path, id: card.id } }));
        return true;
      } catch (e) { emit({ kind: 'error', message: `could not write handoff card: ${(e as Error).message}` }); return false; }
    };
    void handle.done.then(async () => {
      this.live.delete(id);
      lean?.cleanup();
      const outcome = limit ? 'limit' : ctxStop ? 'context' : entry.stopped ? 'stopped' : events.some((e) => e.kind === 'error') || !events.some((e) => e.kind === 'done' && e.ok) ? 'failed' : branch ? 'review' : 'done';   // work on a task branch is not "done" until the review gate lets it through
      this.db.prepare('UPDATE run SET outcome = ?, ended_at = ? WHERE id = ?').run(outcome, new Date().toISOString(), id);
      // A reviewer has no work to hand over, and its projectRoot is the task folder: a card there would be committed into the branch.
      if (outcome === 'limit' && limit && reviewer) emit({ kind: 'warn', message: 'reviewer stopped on a usage limit: no handoff card (the review round fails and can be run again)' });
      else if (outcome === 'limit' && limit) await handover('limit_reached', limit.resetsAt);
      else if (outcome === 'context') {
        // Same worktree, same agent, model, effort and permission (a review thread stays in plan): only the context is fresh.
        if (await handover('context') && !ctxCapped) {
          try { const next = this.handoff(id, { agent: req.agent, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) }); emit({ kind: 'warn', message: `новая сессия по карточке: ${next.id}` }); }
          catch (e) { emit({ kind: 'warn', message: `не удалось начать новую сессию: ${(e as Error).message.slice(0, 200)}; продолжите вручную по карточке` }); }
        }
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

  /** Record what the verify command said about a run: true = passed (1), false = failed (0). NULL (never set) means none ran. Quality scoring reads it (econ `runScore`). */
  setVerified(id: string, passed: boolean): void { this.db.prepare('UPDATE run SET verify_passed = ? WHERE id = ?').run(passed ? 1 : 0, id); }

  stop(id: string): boolean { const r = this.live.get(id); if (!r) return false; r.stopped = true; r.handle.stop(); return true; }
  isLive = (id: string): boolean => this.live.has(id);

  get(id: string): RunRow | undefined { return this.db.prepare(`SELECT ${COLS} FROM run WHERE id = ?`).get(id) as unknown as RunRow | undefined; }
  /** The user's runs (chats, tasks); review-gate reviewer runs are not listed. */
  list(f: { projectId?: number; limit?: number } = {}): RunRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM run WHERE (work_mode IS NULL OR work_mode != '${REVIEWER_MODE}') ${f.projectId != null ? 'AND project_id = ?' : ''} ORDER BY started_at DESC LIMIT ?`).all(...(f.projectId != null ? [f.projectId] : []), f.limit ?? 50) as unknown as RunRow[];
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
