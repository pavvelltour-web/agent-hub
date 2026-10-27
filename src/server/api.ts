import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectAgents, type AgentInfo } from '../adapters/locate.ts';
import { authStatus, forgetAuth, type AuthInfo } from '../adapters/auth.ts';
import { openLogin, pickFolder } from '../adapters/native.ts';
import { loadMatrix } from '../adapters/probe.ts';
import { applyWorkMode, loadWorkModes } from '../core/workmodes.ts';
import { applyPlan, describe, listBackups, undoBackup } from '../core/plan.ts';
import { planInit, listPacks } from '../core/init.ts';
import { graphStatus, locateGraphify, updateGraph, type GraphTool } from '../core/graph.ts';
import { addSkillRoot, HUB_HOME, library, loadUserConfig, removeSkillRoot, REPO_ROOT, saveUserConfig, skillRoots } from '../core/registry.ts';
import { scout } from '../core/scout.ts';
import { fetchAitmpl, searchGithub } from '../core/scout-remote.ts';
import { planLibraryInstall, previewComponent } from '../core/install-remote.ts';
import { planInstall } from '../core/install.ts';
import { listPlugins } from '../core/profile.ts';
import { auditLoading, compileProfile, skillInfoFrom, type Desired, type SkillState } from '../core/loading.ts';
import { effective } from '../core/plan.ts';
import type { AgentId, RegistryEntry } from '../core/types.ts';
import { build, KINDS, render, type Format, type Kind } from '../diagram/index.ts';
import { advise, MODEL_GUIDE, ROUTING, type LimitState, type TaskClass } from '../econ/advisor.ts';
import { calibrate, costUsd, effortProfiles, estimate, modelStats, outcomes, PRICES_VERIFIED_AT, profileFromHistory } from '../econ/econ.ts';
import { compareStrategies } from '../econ/strategies.ts';
import { classify } from '../econ/classify.ts';
import { reloadPrices, saveOverride, type PriceTable } from '../econ/prices.ts';
import { agentOf, modelKey } from '../econ/router.ts';
import { PRIORS, TAGS } from '../econ/priors.ts';
import { buildCases, exportCases, NEVER_INCLUDED } from '../econ/cases.ts';
import { startOverhead } from '../econ/overhead.ts';
import { readSessionEvents as readClaudeEvents, syncClaude, type SyncStats } from '../history/claude.ts';
import { readSessionEvents as readCodexEvents, syncCodex } from '../history/codex.ts';
import { resolveSource } from '../history/source.ts';
import { addLimit, getSession, latestLimit, listProjects, listSessions, projectId, search, usageByModel, type Db } from '../history/store.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSecretPath } from '../lib/paths.ts';
import { checkSparse, git } from '../run/git.ts';
import { defaultLadder, readCascadeFor, readVerify, runCascade, validArgv, type CascadeResult, type Rung } from '../run/cascade.ts';
import { approveVerify } from '../review/checks.ts';
import { RunManager, type RunRow, type StartReq } from '../run/runner.ts';
import { approveStage, stageStatus } from '../stages/engine.ts';
import { GateError, answer as answerFindingGate, approve as approveReview, approveReviewChecks, canAcceptNow, launchReview, reviewChecks, reviewDiffText, reviewView, reviewsOfRun, startFix, usableAgents } from '../review/gate.ts';
import { MAX_DIFF_BYTES, SEED_CASES_DIR, caseFromFinding, caseSummary, incidentCasesDir, readBaseline, saveCase } from '../review/eval.ts';
import { getReview } from '../review/store.ts';
import { appendRuleChange, repeatedFindings, reviewMdExists, suggestRuleLine } from '../review/reviewmd.ts';

export interface Ctx { db: Db; runs: RunManager; agents?: () => Record<AgentId, AgentInfo>; auth?: (id: AgentId, info: AgentInfo) => AuthInfo; native?: { pickFolder: () => { path: string | null }; openLogin: (id: AgentId, exe: string) => void }; syncDirs?: { claude?: string; codex?: string }; review?: { available?: AgentId[] }; reviewEval?: { casesDir?: string; seedDir?: string; baselinePath?: string };
  /** Tests: which graphify to use (`tool: null` = none). Without it the hub looks for graphify on this PC. */
  graph?: { tool?: GraphTool | null } }
export interface Res { status: number; json?: unknown }
type Body = Record<string, unknown>;
type Handler = (c: Ctx, p: { params: string[]; q: URLSearchParams; body: Body }) => Res | Promise<Res>;

const pricesJson = (t: PriceTable): Res => ok({ models: [...t.models.values()].map((e) => ({ ...e, overridden: t.overridden.has(e.id) })), rejected: t.rejected, rejectedRows: t.rejectedRows, ...(t.overrideProblem ? { overrideProblem: t.overrideProblem } : {}) });
const ok = (json: unknown): Res => ({ status: 200, json });
const bad = (status: number, error: string): Res => ({ status, json: { error } });
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

const graphToolOf = (c: Ctx): GraphTool | undefined => (c.graph && 'tool' in c.graph ? c.graph.tool ?? undefined : locateGraphify());

function rootOf(c: Ctx, id: number | undefined): string {
  const r = id == null ? undefined : (c.db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root;
  if (!r) throw new HttpError(404, 'project not found');
  return r;
}
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

/**
 * Verify-and-escalate start: the verify command comes from the request (the user's own browser) or the PROJECT ROOT's hub.json, and runs only after the
 * same digest-pinned approval as review checks. Unapproved: 400 with `needsApproval` and the plan, nothing starts. Answers as soon as the first run exists.
 */
async function cascadeStart(c: Ctx, body: Body, req: StartReq, resuming: boolean, model: string | undefined, effort: string | undefined, advice: unknown): Promise<Res> {
  if (resuming) return bad(400, 'a cascade starts a fresh task: it cannot resume a thread or use a work mode');
  const fromBody = body['verify'] !== undefined && body['verify'] !== null;
  if (fromBody && !validArgv(body['verify'])) return bad(400, 'verify must be a non-empty list of strings (program and arguments)');
  const verify = fromBody ? (body['verify'] as string[]) : readVerify(req.projectRoot);
  if (!verify) return bad(400, 'no verify command: fill in «Проверка» or put "verify": ["npm", "test"] into hub.json of the project folder');
  const ladder: Rung[] = defaultLadder();
  const ex = ladder[0] as Rung;   // the first rung is what the user chose (or the advisor picked) for the task; the other two stay the default
  ladder[0] = { ...ex, agent: req.agent, model: model ?? (req.agent === ex.agent ? ex.model : ''), effort: effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? (effort as Rung['effort']) : ex.effort };
  const available = c.review?.available ?? usableAgents().available;
  const missing = [...new Set(ladder.map((r) => r.agent))].filter((a) => !available.includes(a));
  if (missing.length) return bad(400, `${missing.join(', ')} is not usable now (not installed or not signed in): the cascade would stop at that step`);
  const out = await new Promise<{ run: RunRow } | { result: CascadeResult } | { error: Error }>((resolve) => {
    runCascade({ req: { ...req, mode: 'task' }, verify, ladder, runs: c.runs, maxRepairs: 2, onStart: (run) => resolve({ run }) }).then((result) => resolve({ result }), (error: Error) => resolve({ error }));
  });
  if ('run' in out) return ok({ run: out.run, advice, cascade: true });
  if ('error' in out) return bad(400, out.error.message);
  const r = out.result;
  return r.needsApproval ? { status: 400, json: { error: r.reason ?? 'the verify command is not approved', needsApproval: true, digest: r.needsApproval.digest, plan: r.needsApproval } } : bad(400, r.reason ?? 'the cascade did not start');
}

const RUN_ID = /^r[0-9a-z]{2,40}$/, REVIEW_ID = /^rv[0-9a-z]{2,40}$/, FINDING_ID = /^fd[0-9a-z]{2,40}$/, SHA = /^[0-9a-f]{7,40}$/i;
function reviewId(c: Ctx, raw: string | undefined): string {
  if (!raw || !REVIEW_ID.test(raw) || !getReview(c.db, raw)) throw new HttpError(404, 'review not found');
  return raw;
}

/**
 * Where reviewer-quality cases and the baseline live. Incidents are written under the hub home (`<home>/review-eval/cases`), never into the hub's
 * own tree; the shipped seed cases (`eval/review`) are read-only. Tests point all three elsewhere.
 */
const evalPaths = (c: Ctx): { casesDir: string; seedDir: string; baselinePath: string } => ({ casesDir: c.reviewEval?.casesDir ?? incidentCasesDir(HUB_HOME), seedDir: c.reviewEval?.seedDir ?? SEED_CASES_DIR, baselinePath: c.reviewEval?.baselinePath ?? join(HUB_HOME, 'review-eval-baseline.json') });

let syncState: { running: boolean; last?: { at: string; claude: SyncStats; codex: SyncStats; ms: number }; error?: string } = { running: false };

function limitState(c: Ctx, agent: AgentId): (LimitState & { resetsAt: number | null; windowMinutes: number | null; source: string; ts: string; stale: boolean; planType: string | null }) | undefined {
  const l = latestLimit(c.db, agent);
  if (!l) return undefined;
  const stale = l.resetsAt != null && l.resetsAt * 1000 < Date.now();
  return { usedPercent: stale ? null : l.usedPercent, reached: !stale && (l.usedPercent ?? 0) >= 100, resetsAt: l.resetsAt, windowMinutes: l.windowMinutes, source: l.source, ts: l.ts, stale, planType: l.planType };
}
/** What the user's own finished runs and preferences add to a model decision. */
const learned = (c: Ctx): { stats: ReturnType<typeof modelStats>; effortProfiles: ReturnType<typeof effortProfiles>; priceWeight: number; explore: number } => { const r = loadUserConfig().routing ?? {}; return { stats: modelStats(c.db), effortProfiles: effortProfiles(c.db), priceWeight: Math.min(5, Math.max(0.2, r.priceWeight ?? 1)), explore: Math.min(0.3, Math.max(0, r.explore ?? 0)) }; };
const limitsFor = (c: Ctx): Partial<Record<AgentId, LimitState>> => Object.fromEntries((['claude', 'codex'] as AgentId[]).map((a) => [a, limitState(c, a)]).filter(([, v]) => v)) as Partial<Record<AgentId, LimitState>>;

const entryView = (e: RegistryEntry): Record<string, unknown> => ({ id: e.id, kind: e.kind, title: e.title, description: clip(e.description, 220), tokenCost: e.tokenCost, license: e.license ?? 'unknown', compat: e.compat, risk: e.risk, source: e.source.type, sourceVerified: e.sourceVerified, downloads: e.downloads ?? null, scan: e.scan ?? null, scope: e.scope ?? null, visibleTo: e.visibleTo ?? [], globalVisibleTo: e.globalVisibleTo ?? [] });

const NAME = /^[\w.@ -]{1,120}$/;
/** Body → desired profile, or undefined when empty/invalid. Only known states and plain names get through. */
function parseDesired(body: Body): Desired | undefined {
  const d: Desired = { skills: {}, plugins: {} };
  const sk = body['skills'], pg = body['plugins'];
  if (sk && typeof sk === 'object') for (const [k, v] of Object.entries(sk)) if (NAME.test(k) && (v === 'on' || v === 'off' || v === 'name-only')) (d.skills as Record<string, SkillState>)[k] = v;
  if (pg && typeof pg === 'object') for (const [k, v] of Object.entries(pg)) if (NAME.test(k) && typeof v === 'boolean') (d.plugins as Record<string, boolean>)[k] = v;
  if (Array.isArray(body['disable'])) for (const k of body['disable']) if (typeof k === 'string' && NAME.test(k)) (d.plugins as Record<string, boolean>)[k] = false;
  return Object.keys(d.skills ?? {}).length || Object.keys(d.plugins ?? {}).length ? d : undefined;
}

const ROUTES: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/state$/, (c) => {
    const agents = (c.agents ?? detectAgents)();
    return ok({ version: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version, home: HUB_HOME, agents: Object.fromEntries((['claude', 'codex'] as AgentId[]).map((id) => [id, { ...agents[id], auth: (c.auth ?? authStatus)(id, agents[id]) }])), packs: listPacks().map((p) => ({ id: p.id, title: p.title })), sync: syncState });
  }],
  ['GET', /^\/api\/sync$/, () => ok(syncState)],
  ['GET', /^\/api\/workmodes$/, (c, { q }) => {
    const agent = q.get('agent') === 'codex' ? 'codex' : 'claude'; const pid = num(q.get('project'));
    const root = pid != null ? (c.db.prepare('SELECT root FROM project WHERE id = ?').get(pid) as { root: string } | undefined)?.root : undefined;
    return ok(loadWorkModes().map((m) => { let unavailable: string | null = null; if (root) { try { applyWorkMode(m, { agent, prompt: 'x', projectRoot: root }); } catch (e) { unavailable = (e as Error).message; } } return { ...m, unavailable }; }));
  }],
  ['GET', /^\/api\/modes\/matrix$/, (c) => {
    const agents = (c.agents ?? detectAgents)(); const saved = loadMatrix();
    return ok(Object.fromEntries((['claude', 'codex'] as AgentId[]).map((id) => [id, { verified: !!saved[id] && agents[id].version != null && saved[id]?.cliVersion === agents[id].version, cliVersion: agents[id].version ?? null, at: saved[id]?.at ?? null, matrix: saved[id]?.matrix ?? null }])));
  }],
  ['POST', /^\/api\/sync$/, (c) => {
    if (syncState.running) return ok(syncState);
    syncState = { running: true };
    const t = Date.now();
    void (async () => {
      try { const cl = await syncClaude(c.db, c.syncDirs?.claude); const cx = await syncCodex(c.db, c.syncDirs?.codex); syncState = { running: false, last: { at: new Date().toISOString(), claude: cl, codex: cx, ms: Date.now() - t } }; }
      catch (e) { syncState = { running: false, error: (e as Error).message }; }
    })();
    return ok(syncState);
  }],
  ['POST', /^\/api\/projects\/pick$/, (c) => {
    let r; try { r = (c.native?.pickFolder ?? pickFolder)(); } catch (e) { return bad(501, (e as Error).message); }
    if (!r.path) return ok({ cancelled: true });
    if (isSecretPath(r.path)) return bad(400, 'this folder is not allowed');
    return ok({ id: projectId(c.db, r.path), path: r.path });
  }],
  ['POST', /^\/api\/agents\/login$/, (c, { body }) => {
    const id = body['agent'] === 'claude' || body['agent'] === 'codex' ? body['agent'] : undefined;
    const info = id ? (c.agents ?? detectAgents)()[id] : undefined;
    if (!id || !info?.installed || !info.path) return bad(400, 'agent is not installed');
    try { (c.native?.openLogin ?? openLogin)(id, info.path); forgetAuth(id); return ok({ opened: true }); } catch (e) { return bad(501, (e as Error).message); }
  }],
  ['GET', /^\/api\/projects$/, (c) => ok(listProjects(c.db).map((p) => ({ ...p, exists: existsSync(p.root), linked: existsSync(join(p.root, 'hub.json')) })))],
  ['POST', /^\/api\/projects$/, (c, { body }) => {
    const path = str(body['path']);
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) return bad(400, 'folder not found');
    if (isSecretPath(path)) return bad(400, 'this folder is not allowed');
    return ok({ id: projectId(c.db, path) });
  }],
  ['GET', /^\/api\/projects\/(\d+)$/, (c, { params }) => {
    const id = Number(params[0]); const root = rootOf(c, id);
    const exists = existsSync(root);
    const rd = (f: string): any => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return undefined; } };
    const lock = exists ? rd('hub.lock.json') : undefined;
    return ok({
      project: { id, root, slug: root.split('/').filter(Boolean).pop(), exists }, hub: exists ? rd('hub.json') : undefined, toolkit: exists ? rd('toolkit.json') : undefined,
      tokens: (lock?.entries ?? []).reduce((a: number, e: { tokenCost: number }) => a + e.tokenCost, 0), stages: exists ? stageStatus(root) : [],
      sessions: listSessions(c.db, { projectId: id, topLevel: true, limit: 6 }), runs: c.runs.list({ projectId: id, limit: 6 }),
      counts: c.db.prepare('SELECT agent, COUNT(*) AS n FROM session WHERE project_id = ? AND parent_id IS NULL GROUP BY agent').all(id),
    });
  }],
  ['GET', /^\/api\/sessions$/, (c, { q }) => ok(listSessions(c.db, { ...(num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}), ...(q.get('agent') ? { agent: q.get('agent') as string } : {}), ...(q.get('model') ? { model: q.get('model') as string } : {}), ...(q.get('q') ? { q: q.get('q') as string } : {}), topLevel: q.get('all') !== '1', limit: Math.min(200, num(q.get('limit')) ?? 50), offset: num(q.get('offset')) ?? 0 }))],
  // The conversation itself, rendered from the agent's own file. The path comes from the index (never from the request) and must stay inside the history folders.
  ['GET', /^\/api\/sessions\/(.+)\/events$/, async (c, { params, q }) => {
    const row = c.db.prepare('SELECT source_kind AS kind, source_path AS path FROM session WHERE id = ?').get(decodeURIComponent(params[0] as string)) as { kind: string; path: string } | undefined;
    if (!row) return bad(404, 'session not found');
    const read = row.kind === 'claude-jsonl' ? readClaudeEvents : row.kind === 'codex-rollout' ? readCodexEvents : undefined;
    if (!read) return bad(400, 'this session has no readable source file');
    const src = resolveSource(row.path);
    if ('refused' in src) return bad(403, src.refused);
    if ('moved' in src) return ok({ events: [], next: null, moved: true });
    try { return ok(await read(src.path, { offset: num(q.get('offset')) ?? 0, limit: Math.min(500, Math.max(1, num(q.get('limit')) ?? 200)) })); }
    catch { return bad(403, 'source is not a conversation file'); }
  }],
  ['GET', /^\/api\/sessions\/(.+)$/, (c, { params, q }) => { const s = getSession(c.db, decodeURIComponent(params[0] as string), { limit: Math.min(500, num(q.get('limit')) ?? 200), offset: num(q.get('offset')) ?? 0 }); return s ? ok(s) : bad(404, 'session not found'); }],
  ['GET', /^\/api\/search$/, (c, { q }) => ok(search(c.db, q.get('q') ?? '', { ...(num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}), ...(q.get('agent') ? { agent: q.get('agent') as string } : {}), limit: 40 }))],

  ['GET', /^\/api\/library$/, (c, { q }) => {
    const pid = num(q.get('project'));
    const root = pid != null ? rootOf(c, pid) : undefined;
    const lib = library(root && existsSync(root) ? root : undefined);
    const roots = skillRoots(root);
    const skills = lib.filter((e) => e.kind === 'skill');
    const paid = (a: AgentId): { skills: number; tokens: number } => { const g = skills.filter((e) => e.globalVisibleTo?.includes(a)); return { skills: g.length, tokens: g.reduce((x, e) => x + e.tokenCost, 0) }; };
    const pl = listPlugins(); const plugins = new Map<string, { id: string; name: string; agents: AgentId[]; skills: number; tokens: number; enabled: boolean; suggest: boolean }>();
    for (const a of ['claude', 'codex'] as AgentId[]) for (const p of pl[a]) { const x = plugins.get(p.id) ?? { id: p.id, name: p.name, agents: [], skills: p.skills, tokens: p.tokens, enabled: p.enabled, suggest: p.suggestDisable }; x.agents.push(a); x.enabled = x.enabled || p.enabled; plugins.set(p.id, x); }
    return ok({ plugins: [...plugins.values()], entries: lib.map(entryView), roots, tax: { skills: skills.length, tokensPerTurn: skills.reduce((a, e) => a + e.tokenCost, 0), claude: paid('claude'), codex: paid('codex'), hubOnly: skills.filter((e) => !e.visibleTo?.length).length } });
  }],
  ['GET', /^\/api\/scout$/, (c, { q }) => {
    const root = rootOf(c, num(q.get('project')));
    const lib = library(existsSync(root) ? root : undefined);
    const tk = (() => { try { return JSON.parse(readFileSync(join(root, 'toolkit.json'), 'utf8')) as { selected: { id: string }[] }; } catch { return { selected: [] }; } })();
    const brief = (() => { try { return readFileSync(join(root, 'brief.md'), 'utf8'); } catch { return q.get('brief') ?? ''; } })();
    return ok(scout(lib, { brief: brief || (q.get('brief') ?? ''), projectType: q.get('type') ?? 'web-saas', installed: tk.selected.map((s) => s.id) }).map((x) => ({ ...entryView(x.entry), score: x.score, reasons: x.reasons })));
  }],
  ['GET', /^\/api\/scout\/remote$/, async (c, { q }) => {
    const src = q.get('source'); const brief = q.get('q') ?? '';
    try {
      const lib = src === 'aitmpl' ? await fetchAitmpl((['skills', 'mcps', 'hooks', 'agents', 'commands'].includes(q.get('kind') ?? '') ? q.get('kind') : 'skills') as 'skills')
        : src === 'github' ? searchGithub(brief) : undefined;
      if (!lib) return bad(400, 'source must be aitmpl or github');
      const top = scout(lib, { brief, projectType: q.get('type') ?? 'web-saas', limit: 20, keepAll: true });
      return ok({ source: src, note: 'Proposals only. Nothing is downloaded or installed; read the source and license first.', items: top.map((x) => ({ ...entryView(x.entry), installCommand: x.entry.installCommand ?? null, score: x.score, reasons: x.reasons })) });
    } catch (e) { return bad(502, (e as Error).message); }
  }],
  ['GET', /^\/api\/remote\/preview$/, async (_c, { q }) => {
    try { const { payload: _p, ...pv } = await previewComponent(q.get('id') ?? ''); return ok({ ...pv, text: clip(pv.text, 12000) }); }
    catch (e) { return bad(502, (e as Error).message); }
  }],
  ['POST', /^\/api\/remote\/install\/(plan|apply)$/, async (_c, { params, body }) => {
    let pv; try { pv = await previewComponent(String(body['id'] ?? '')); } catch (e) { return bad(502, (e as Error).message); }
    if (pv.blocked) return bad(400, pv.blocked);
    const plan = planLibraryInstall(pv);
    if (params[0] === 'plan') return ok({ digest: pv.digest, notes: plan.notes, changes: plan.changes.map((ch) => ({ path: ch.path.slice(HUB_HOME.length + 1).replace(/\\/g, '/'), action: ch.action, note: ch.note ?? null, before: null, after: clip(ch.after, 3000) })) });
    if (body['approved'] !== true) return bad(400, 'apply needs approved: true');
    if (body['digest'] !== pv.digest) return bad(409, 'the component changed since you previewed it; review it again');
    const r = applyPlan(plan, { approved: true });
    return ok({ backupId: r.backupId, written: r.written.length, fallbacks: r.fallbacks });
  }],
  ['GET', /^\/api\/config$/, () => { const cfg = loadUserConfig(); return ok({ home: HUB_HOME, extraSkillRoots: (cfg.extraSkillRoots ?? []).map((p) => ({ path: p, exists: existsSync(p) })) }); }],
  ['POST', /^\/api\/config\/skill-root$/, (_c, { body }) => {
    try { if (body['remove'] === true) removeSkillRoot(String(body['path'] ?? '')); else addSkillRoot(String(body['path'] ?? '')); return ok({ extraSkillRoots: loadUserConfig().extraSkillRoots ?? [] }); }
    catch (e) { return bad(400, (e as Error).message); }
  }],
  ['GET', /^\/api\/plugins$/, () => ok(listPlugins())],
  ['GET', /^\/api\/loading$/, (c, { q }) => { const root = rootOf(c, num(q.get('project'))); if (!existsSync(root)) return bad(400, 'project folder is missing on disk'); return ok(auditLoading(root)); }],
  ['POST', /^\/api\/(profile|install)\/(plan|apply)$/, (c, { params, body }) => {
    const root = rootOf(c, num(body['projectId']));
    if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    let plan, items: unknown;
    try {
      if (params[0] === 'install') { const r = planInstall(root); plan = r.plan; items = r.items; }
      else {
        const d = parseDesired(body);
        if (!d) return bad(400, 'skills: {name: on|name-only|off} and/or plugins: {id: boolean} required');
        plan = effective({ root, changes: compileProfile(root, d, skillInfoFrom(library(root))), notes: ['Codex: a project-level override of skills/plugins is not verified; Claude follows its documented skillOverrides / enabledPlugins.'] });
      }
    } catch (e) { return bad(400, (e as Error).message); }
    if (params[1] === 'plan') return ok({ lines: describe(plan), notes: plan.notes, items: items ?? null, changes: plan.changes.map((ch) => ({ path: ch.path.slice(root.length + 1).replace(/\\/g, '/'), action: ch.action, note: ch.note ?? null, before: ch.before === null ? null : clip(ch.before, 3000), after: ch.action === 'link' ? ch.after : clip(ch.after, 3000) })) });
    if (body['approved'] !== true) return bad(400, 'apply needs approved: true');
    const r = applyPlan(plan, { approved: true });
    return ok({ backupId: r.backupId, written: r.written.length, fallbacks: r.fallbacks });
  }],
  ['POST', /^\/api\/init\/(plan|apply)$/, (c, { params, body }) => {
    const root = rootOf(c, num(body['projectId']));
    if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    const ids = (k: string): string[] => (Array.isArray(body[k]) ? (body[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const hubType = ((): string | undefined => { try { return (JSON.parse(readFileSync(join(root, 'hub.json'), 'utf8')) as { project?: { type?: string } }).project?.type; } catch { return undefined; } })();
    let plan; try { plan = planInit(root, { type: str(body['type']) ?? hubType ?? 'web-saas', extra: ids('extra'), remove: ids('remove'), graphify: graphToolOf(c) ?? null }); } catch (e) { return bad(400, (e as Error).message); }
    if (params[0] === 'plan') return ok({ lines: describe(plan), notes: plan.notes, missing: plan.missing, selected: plan.selected.map((e) => e.id), changes: plan.changes.map((ch) => ({ path: ch.path.slice(root.length + 1).replace(/\\/g, '/'), action: ch.action, note: ch.note ?? null, before: ch.before === null ? null : clip(ch.before, 3000), after: ch.action === 'link' ? ch.after : clip(ch.after, 3000) })) });
    if (body['approved'] !== true) return bad(400, 'apply needs approved: true');
    const r = applyPlan(plan, { approved: true });
    return ok({ backupId: r.backupId, written: r.written.length, fallbacks: r.fallbacks });
  }],
  // ---- project graph (graphify): status, and a background update the user approved. The tool writes only <project>/graphify-out; see ADR-021.
  ['GET', /^\/api\/graph$/, (c, { q }) => ok({ available: !!graphToolOf(c), ...graphStatus(rootOf(c, num(q.get('project')))) })],
  ['POST', /^\/api\/graph\/update$/, (c, { body }) => {
    const root = rootOf(c, num(body['projectId']));
    if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    if (body['approved'] !== true) return bad(400, 'update needs approved: true');
    const tool = graphToolOf(c);
    if (!tool) return bad(400, 'graphify was not found on this computer');
    const r = updateGraph(root, { tool, home: c.runs.home });
    return r.started ? ok({ started: true }) : bad(r.reason === 'already running' ? 409 : 400, r.reason ?? 'not started');
  }],
  // ---- review rules: repeated bug classes -> one line in the project's REVIEW.md. Writes go through the same plan -> approval -> backup -> undo flow as init.
  ['GET', /^\/api\/projects\/(\d+)\/review-rules$/, (c, { params }) => {
    const pid = num(params[0]); const root = rootOf(c, pid);
    return ok({ hasReviewMd: reviewMdExists(root), repeated: repeatedFindings(c.db, pid as number).map((r) => ({ ...r, line: suggestRuleLine(r.classOfBug) })) });
  }],
  ['POST', /^\/api\/projects\/(\d+)\/review-rules$/, (c, { params, body }) => {
    const root = rootOf(c, num(params[0]));
    if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    let plan; try { plan = effective({ root, changes: [appendRuleChange(root, typeof body['line'] === 'string' ? body['line'] : '')], notes: [] }); } catch (e) { const m = (e as Error).message; return bad(/already/.test(m) ? 409 : 400, m); }
    if (body['preview'] === true) return ok({ lines: describe(plan), changes: plan.changes.map((ch) => ({ path: 'REVIEW.md', action: ch.action, note: ch.note ?? null, before: ch.before === null ? null : clip(ch.before, 3000), after: clip(ch.after, 3000) })) });
    if (body['approved'] !== true) return bad(400, 'apply needs approved: true');
    const r = applyPlan(plan, { approved: true });
    return ok({ backupId: r.backupId, written: r.written.length });
  }],
  ['GET', /^\/api\/backups$/, (c, { q }) => ok(listBackups(rootOf(c, num(q.get('project')))))],
  ['POST', /^\/api\/undo$/, (c, { body }) => { const id = str(body['backupId']); if (!id || !/^[\w.-]+$/.test(id)) return bad(400, 'bad backup id'); return ok(undoBackup(rootOf(c, num(body['projectId'])), id)); }],
  ['GET', /^\/api\/stages$/, (c, { q }) => { const root = rootOf(c, num(q.get('project'))); return ok(existsSync(root) ? stageStatus(root) : []); }],
  ['POST', /^\/api\/stages\/approve$/, (c, { body }) => { try { return ok(approveStage(rootOf(c, num(body['projectId'])), Number(body['stage']))); } catch (e) { return bad(400, (e as Error).message); } }],

  ['GET', /^\/api\/models$/, (c) => {
    const agents = (c.agents ?? detectAgents)();
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const usage = usageByModel(c.db, since).map((u) => ({ ...u, costUsd: costUsd(u.model, u) }));
    return ok({
      agents: (['claude', 'codex'] as AgentId[]).map((id) => ({ id, ...agents[id], limit: limitState(c, id) ?? null, calibration: calibrate(c.db, id) })),
      usage, routing: ROUTING, guide: MODEL_GUIDE, priors: { rows: PRIORS.priors, surcharges: PRIORS.surcharges }, pricesVerifiedAt: PRICES_VERIFIED_AT, profile: profileFromHistory(c.db),
    });
  }],
  ['GET', /^\/api\/prices$/, () => pricesJson(reloadPrices(HUB_HOME))],
  ['POST', /^\/api\/prices$/, (_c, { body }) => {
    const id = str(body['model']);
    if (!id) return bad(400, 'model required');
    try {
      if (body['reset'] === true) return pricesJson(saveOverride(HUB_HOME, id, null));
      const [input, cacheRead, output] = [body['input'], body['cacheRead'], body['output']];
      if (typeof input !== 'number' || typeof cacheRead !== 'number' || typeof output !== 'number') return bad(400, 'input, cacheRead and output must be numbers (USD per 1M tokens)');
      return pricesJson(saveOverride(HUB_HOME, id, { input, cacheRead, output }));
    } catch (e) { return bad(400, (e as Error).message); }
  }],
  ['POST', /^\/api\/classify$/, (_c, { body }) => { const p = str(body['prompt']); return p ? ok(classify(p)) : bad(400, 'prompt required'); }],
  ['GET', /^\/api\/overhead$/, (c, { q }) => ok(startOverhead(c.db, num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}))],
  ['POST', /^\/api\/runs\/(\w+)\/rating$/, (c, { params, body }) => {
    const r = num(body['rating']);
    if (r == null || ![0, 1, 2].includes(r)) return bad(400, 'rating must be 0 (no), 1 (partly) or 2 (yes)');
    const run = c.runs.get(params[0] as string);
    if (!run) return bad(404, 'run not found');
    if (run.outcome !== 'done' && run.outcome !== 'review' && run.outcome !== 'failed') return bad(400, 'only finished runs can be rated');
    c.db.prepare('UPDATE run SET rating = ? WHERE id = ?').run(r, run.id);
    return ok({ ok: true });
  }],
  ['GET', /^\/api\/routing$/, (c) => { const l = learned(c); const st = Object.entries(l.stats).reduce((a, [k, x]) => a + (k.split('|').length === 2 ? x.n : 0), 0);  /* per-model keys only: the per-pair keys count the same runs again */ return ok({ priceWeight: l.priceWeight, explore: l.explore, observedRuns: st }); }],
  ['POST', /^\/api\/routing$/, (_c, { body }) => {
    const pw = num(body['priceWeight']), ex = num(body['explore']);
    if ((pw != null && (pw < 0.2 || pw > 5)) || (ex != null && (ex < 0 || ex > 0.3))) return bad(400, 'priceWeight must be 0.2–5, explore 0–0.3');
    const cfg = loadUserConfig();
    saveUserConfig({ ...cfg, routing: { ...(cfg.routing ?? {}), ...(pw != null ? { priceWeight: pw } : {}), ...(ex != null ? { explore: ex } : {}) } });
    return ok({ ok: true });
  }],
  ['GET', /^\/api\/sharing$/, (c) => { const s = loadUserConfig().sharing; const n = buildCases(c.db).length; return ok({ consent: !!s?.consent, at: s?.at ?? null, caseCount: n, neverIncluded: NEVER_INCLUDED, sent: false }); }],
  ['POST', /^\/api\/sharing$/, (_c, { body }) => {
    if (typeof body['consent'] !== 'boolean') return bad(400, 'consent: true or false');
    const cfg = loadUserConfig();
    saveUserConfig({ ...cfg, sharing: { consent: body['consent'], at: new Date().toISOString(), version: 1 } });
    return ok({ consent: body['consent'] });
  }],
  ['GET', /^\/api\/cases\/preview$/, (c, { q }) => { const all = buildCases(c.db); return ok({ count: all.length, sample: all.slice(-Math.min(20, num(q.get('limit')) ?? 5)), neverIncluded: NEVER_INCLUDED }); }],
  ['POST', /^\/api\/cases\/export$/, (c) => { try { return ok(exportCases(c.db, !!loadUserConfig().sharing?.consent)); } catch (e) { return bad(403, (e as Error).message); } }],
  ['GET', /^\/api\/outcomes$/, (c) => {
    const rows = outcomes(c.db);
    // limit share needs a MEASURED calibration (the wide prior is not a number to divide by); the middle of the measured range per agent
    const cal = { claude: calibrate(c.db, 'claude'), codex: calibrate(c.db, 'codex') };
    const mwPerPct = (model: string): number | null => { const k = cal[agentOf(modelKey(model))]; return k.source === 'measured' ? (k.lowMwPerPct + k.highMwPerPct) / 2 : null; };
    return ok({ rows, strategies: compareStrategies(rows, { mwPerPct }) });
  }],
  ['POST', /^\/api\/limits$/, (c, { body }) => {
    const agent = body['agent'] === 'claude' || body['agent'] === 'codex' ? body['agent'] : undefined; const p = num(body['usedPercent']);
    if (!agent || p == null || p < 0 || p > 100) return bad(400, 'agent and usedPercent (0–100) required');
    const reset = str(body['resetsAt']) ? Math.floor(Date.parse(body['resetsAt'] as string) / 1000) : null;
    addLimit(c.db, { agent, ts: new Date().toISOString(), windowMinutes: null, usedPercent: p, resetsAt: Number.isFinite(reset) ? reset : null, planType: null, source: 'manual' });
    return ok({ ok: true });
  }],
  ['POST', /^\/api\/advise$/, (c, { body }) => {
    const cls = (str(body['cls']) ?? 'implement') as TaskClass;
    if (!(cls in ROUTING)) return bad(400, 'unknown task class');
    const choice = advise({ cls, ...(body['implementedBy'] === 'claude' || body['implementedBy'] === 'codex' ? { implementedBy: body['implementedBy'] } : {}), ...(body['securityBoundary'] === true ? { securityBoundary: true } : {}), ...(Array.isArray(body['tags']) ? { tags: (body['tags'] as unknown[]).filter((t): t is string => typeof t === 'string' && (TAGS as readonly string[]).includes(t)) } : {}), ...(num(body['expectedInputTokens']) != null ? { expectedInputTokens: num(body['expectedInputTokens']) as number } : {}), ...(num(body['failures']) != null ? { failures: num(body['failures']) as number } : {}), limits: limitsFor(c), ...learned(c) });
    const est = estimate(profileFromHistory(c.db, choice.agent), choice.model, calibrate(c.db, choice.agent), num(body['scale']) ?? 1);
    return ok({ choice, estimate: est });
  }],

  ['GET', /^\/api\/runs$/, (c, { q }) => ok(c.runs.list({ ...(num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}), limit: Math.min(200, num(q.get('limit')) ?? 50) }).map((r) => ({ ...r, live: c.runs.isLive(r.id) })))],
  ['POST', /^\/api\/runs$/, async (c, { body }) => {
    const prompt = str(body['prompt']);
    if (!prompt) return bad(400, 'prompt required');
    // Continue a session from the history: same agent, same project folder, the agent's own memory of that session.
    const sid = str(body['resumeSessionId']);
    const sess = sid ? (c.db.prepare('SELECT agent, native_id AS nativeId, project_id AS projectId FROM session WHERE id = ?').get(sid) as { agent: AgentId; nativeId: string; projectId: number | null } | undefined) : undefined;
    if (sid && !sess) return bad(404, 'session not found');
    if (sid && !sess?.projectId) return bad(400, 'this session has no project folder: add the folder as a project first');
    const root = rootOf(c, sess?.projectId ?? num(body['projectId']));
    // A work mode shapes the FIRST message of a thread; a resumed thread keeps what it had (permission, branch, prefix).
    const resuming = !!(str(body['resumeRunId']) || sid);
    const wm = !resuming && str(body['workMode']) ? loadWorkModes().find((m) => m.id === body['workMode']) : undefined;
    if (!resuming && str(body['workMode']) && !wm) return bad(400, 'unknown work mode');
    let agent = (sess ? sess.agent : str(body['agent'])) as AgentId | 'auto' | undefined; let model = str(body['model']); let effort = str(body['effort']); let advice: unknown;
    if (!agent || agent === 'auto') { const ch = advise({ cls: (str(body['cls']) as TaskClass) ?? wm?.cls ?? 'implement', limits: limitsFor(c), ...learned(c), ...(body['implementedBy'] === 'claude' || body['implementedBy'] === 'codex' ? { implementedBy: body['implementedBy'] } : {}) }); agent = ch.agent; model ??= ch.model; effort ??= ch.effort; advice = ch; }
    if (agent !== 'claude' && agent !== 'codex') return bad(400, 'agent must be claude, codex or auto');
    const cls = str(body['cls']) && (str(body['cls']) as string) in ROUTING ? (str(body['cls']) as TaskClass) : wm?.cls;
    const est = cls && model ? estimate(profileFromHistory(c.db, agent), model, calibrate(c.db, agent), 1) : undefined;
    let sparse: string[] | undefined;
    try { if (Array.isArray(body['sparse']) && body['sparse'].length) sparse = checkSparse((body['sparse'] as unknown[]).filter((x): x is string => typeof x === 'string')); } catch (e) { return bad(400, (e as Error).message); }
    const askedPerm = body['permission'] === 'plan' || body['permission'] === 'full' || body['permission'] === 'edit' ? body['permission'] : undefined;
    try {
      let req: StartReq = { agent, prompt, projectRoot: root, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(askedPerm ? { permission: askedPerm } : {}), ...(wm ? {} : { mode: body['mode'] === 'task' ? 'task' : 'chat' }), ...(sparse ? { sparse } : {}), ...(cls ? { cls } : {}), ...(est ? { est } : {}), ...(str(body['task']) ? { task: str(body['task']) as string } : {}), ...(str(body['resumeRunId']) ? { resumeRunId: str(body['resumeRunId']) as string } : {}), ...(sess && sid ? { resumeNativeId: sess.nativeId, resumeOfSession: sid } : {}) };
      if (wm) { const depth = str(body['depth']); req = applyWorkMode(depth && wm.autopilot && ['strict', 'normal', 'deep'].includes(depth) ? { ...wm, autopilot: { ...wm.autopilot, depth: depth as 'strict' | 'normal' | 'deep' } } : wm, req); }
      if (body['strategy'] === 'cascade') return await cascadeStart(c, body, req, !!(resuming || wm), model, effort, advice);
      if (body['strategy'] !== undefined && body['strategy'] !== 'single') return bad(400, "strategy must be 'single' or 'cascade'");
      const run = c.runs.start(req);
      return ok({ run, advice });
    } catch (e) { return bad(400, (e as Error).message); }
  }],
  ['GET', /^\/api\/runs\/(\w+)$/, (c, { params }) => {
    const run = c.runs.get(params[0] as string);
    if (!run) return bad(404, 'run not found');
    const card = c.runs.handoffCard(run.id);
    return ok({ run: { ...run, live: c.runs.isLive(run.id) }, events: c.runs.events(run.id).slice(-2000), card: card ?? null });
  }],
  ['GET', /^\/api\/runs\/(\w+)\/cascade$/, (c, { params }) => (RUN_ID.test(params[0] as string) ? ok({ cascade: readCascadeFor(c.runs.home, params[0] as string) ?? null }) : bad(400, 'bad run id'))],
  // The cascade's verify command runs code of the task folder with the user's rights: same digest-pinned approval as review checks (ADR-017). Human HTTP path only.
  ['POST', /^\/api\/verify\/approve$/, (c, { body }) => {
    if (body['approved'] !== true) return bad(400, 'approve needs approved: true');
    const root = rootOf(c, num(body['projectId']));
    const verify = body['verify'] !== undefined && body['verify'] !== null ? body['verify'] : readVerify(root);
    if (!validArgv(verify)) return bad(400, 'no valid verify command');
    const head = git(root, ['rev-parse', 'HEAD']).out;
    if (!/^[0-9a-f]{40}$/.test(head)) return bad(400, 'a cascade needs a git repository with a commit');
    const digest = str(body['digest']);
    if (!digest) return bad(400, 'digest required');
    try { return ok(approveVerify(root, root, head, digest, c.runs.home, verify)); } catch (e) { return bad(409, (e as Error).message); }
  }],
  ['POST', /^\/api\/runs\/(\w+)\/stop$/, (c, { params }) => ok({ stopped: c.runs.stop(params[0] as string) })],
  ['POST', /^\/api\/runs\/(\w+)\/handoff$/, (c, { params, body }) => {
    const to = body['agent'] === 'claude' || body['agent'] === 'codex' ? body['agent'] : undefined;
    if (!to) return bad(400, 'agent required');
    try { return ok({ run: c.runs.handoff(params[0] as string, { agent: to, ...(str(body['model']) ? { model: str(body['model']) as string } : {}), ...(str(body['effort']) ? { effort: str(body['effort']) as string } : {}) }) }); } catch (e) { return bad(400, (e as Error).message); }
  }],

  // ---- review gate: nothing is accepted while it is open. There is no accept/merge endpoint yet; when one is added it MUST call canAccept and refuse when not ok.
  ['POST', /^\/api\/reviews$/, (c, { body }) => {
    const runId = str(body['runId']);
    if (!runId || !RUN_ID.test(runId)) return bad(400, 'runId required');
    const effort = body['effort'];
    if (effort !== undefined && effort !== null && effort !== '' && effort !== 'quick' && effort !== 'standard' && effort !== 'deep') return bad(400, 'effort must be quick, standard or deep');
    if (!c.runs.get(runId)) return bad(404, 'run not found');
    const { review } = launchReview({ runId, ...(effort === 'quick' || effort === 'standard' || effort === 'deep' ? { effort } : {}), runs: c.runs, db: c.db, ...(c.review?.available ? { available: c.review.available } : {}) });   // runs in the background
    return ok(review);
  }],
  ['GET', /^\/api\/reviews\/(\w+)$/, (c, { params }) => { const id = reviewId(c, params[0]); return ok(reviewView(c.db, id, c.runs.home)); }],
  // Checks run the branch's code with the user's rights: the list (argv, the package.json scripts it maps to, file hashes) is shown here and runs
  // only after the user approves exactly that digest. Same guard as every approval: session cookie + same-origin (the hub's agent runs never get the token; ADR-019 "Trust model" says what this does not stop).
  ['GET', /^\/api\/reviews\/(\w+)\/checks$/, (c, { params }) => ok(reviewChecks(c.db, reviewId(c, params[0]), c.runs.home))],
  ['POST', /^\/api\/reviews\/(\w+)\/checks\/approve$/, (c, { params, body }) => {
    const id = reviewId(c, params[0]);
    if (body['approved'] !== true) return bad(400, 'approve needs approved: true');
    const digest = str(body['digest']);
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return bad(400, 'digest: the 64-hex digest shown with the checks');
    return ok(approveReviewChecks(c.db, id, digest, c.runs.home));
  }],
  ['GET', /^\/api\/runs\/(\w+)\/reviews$/, (c, { params }) => (RUN_ID.test(params[0] as string) ? ok(reviewsOfRun(c.db, params[0] as string)) : bad(400, 'bad run id'))],
  ['POST', /^\/api\/findings\/(\w+)\/answer$/, (c, { params, body }) => {
    const id = params[0] as string;
    if (!FINDING_ID.test(id) || !c.db.prepare('SELECT 1 FROM finding WHERE id = ?').get(id)) return bad(404, 'finding not found');
    const a = body['answer'];
    if (a === 'fixed') return bad(400, 'fixed is set by a later commit that removes the flagged line');
    if (a !== 'rejected' && a !== 'intentional' && a !== 'dismissed') return bad(400, 'answer must be rejected, intentional or dismissed');
    const reason = typeof body['reason'] === 'string' ? body['reason'].slice(0, 2000) : undefined;
    try { const finding = answerFindingGate(c.db, id, a, reason); return ok({ finding, review: getReview(c.db, finding.reviewId) }); } catch (e) { return bad(400, (e as Error).message); }
  }],
  ['POST', /^\/api\/reviews\/(\w+)\/approve$/, (c, { params, body }) => {
    if (body['by'] !== undefined && body['by'] !== 'human') return bad(403, 'only a human can approve a review');
    const id = reviewId(c, params[0]);
    const sha = str(body['sha']);
    if (!sha || !SHA.test(sha)) return bad(400, 'sha: 7-40 hex characters');
    const r = getReview(c.db, id) as NonNullable<ReturnType<typeof getReview>>;
    if (!r.headSha.startsWith(sha.toLowerCase())) return bad(409, 'this is not the commit that was reviewed: run the next review round first');
    return ok({ review: approveReview(c.db, id, r.headSha, 'human') });
  }],
  // Interim fixer entry point: resumes the task thread with the open Important/Security BLOCKING lines as the whole prompt. No body is read: nothing from the client reaches the prompt.
  ['POST', /^\/api\/reviews\/(\w+)\/fix$/, (c, { params }) => ok({ run: startFix(c.db, c.runs, reviewId(c, params[0])) })],
  // The verdict is for the branch as git has it NOW (HEAD + clean tree, read by the server). The client's `sha` (the commit the screen
  // shows) is only compared, never used as the head.
  ['GET', /^\/api\/reviews\/(\w+)\/can-accept$/, (c, { params, q }) => {
    const id = reviewId(c, params[0]);
    const sha = (q.get('sha') ?? '').toLowerCase();
    if (!SHA.test(sha)) return bad(400, 'sha: 7-40 hex characters');
    const v = canAcceptNow(c.db, id);
    if (v.head && !v.head.startsWith(sha)) v.why.push(`the screen shows commit ${sha.slice(0, 10)}, but the branch is at ${v.head.slice(0, 10)}: reload`);
    return ok({ ok: v.why.length === 0, why: v.why, head: v.head });
  }],

  // ---- reviewer quality: the last saved baseline and the case counts (never a diff); an incident becomes a case. The diff of a review comes from the review's own commits, never from a path in the request.
  ['GET', /^\/api\/review-eval$/, (c) => ok({ baseline: readBaseline(evalPaths(c).baselinePath), cases: caseSummary([evalPaths(c).seedDir, evalPaths(c).casesDir]) })],
  ['POST', /^\/api\/review-eval\/cases$/, (c, { body }) => {
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    if (!title || title.length > 200) return bad(400, 'title: 1-200 characters');
    const from = body['diffFrom'];
    let diff: string | null, file: string, line: number, brief: string | undefined;
    if (from === 'review') {
      const rid = reviewId(c, str(body['reviewId']));
      const fid = str(body['findingId']);
      if (!fid) return bad(400, 'findingId required');
      const f = FINDING_ID.test(fid) ? c.db.prepare('SELECT file, line FROM finding WHERE id = ? AND review_id = ?').get(fid, rid) as { file: string; line: number } | undefined : undefined;
      if (!f) return bad(404, 'finding not found in this review');
      ({ file, line } = f);
      diff = reviewDiffText(c.db, rid);
      if (!diff) return bad(409, 'cannot read the diff of this review');
      const runId = getReview(c.db, rid)?.runId;
      brief = runId ? (c.db.prepare('SELECT prompt FROM run WHERE id = ?').get(runId) as { prompt: string | null } | undefined)?.prompt?.slice(0, 2000) ?? undefined : undefined;
    } else if (from === 'text') {
      diff = typeof body['diff'] === 'string' ? body['diff'] : null;
      if (!diff || !diff.trim()) return bad(400, 'diff required');
      if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) return bad(400, 'the diff is larger than 200 KB');
      if (typeof body['file'] !== 'string' || !body['file'].trim() || body['file'].length > 1024) return bad(400, 'file required');
      file = body['file'];
      const n = body['line'];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return bad(400, 'line must be a whole number >= 1');
      line = n;
      brief = typeof body['brief'] === 'string' ? body['brief'].slice(0, 2000) : undefined;
    } else return bad(400, "diffFrom must be 'review' or 'text'");
    if (file.split(/[\\/]/).includes('..') || /^([\\/]|[A-Za-z]:)/.test(file)) return bad(400, 'file must be a relative path inside the project');
    try { return ok({ id: saveCase(evalPaths(c).casesDir, caseFromFinding({ title, diff, file, line, ...(brief ? { brief } : {}) })).id }); }
    catch (e) { const m = (e as Error).message; return bad(/already exists/.test(m) ? 409 : 400, m); }
  }],

  ['GET', /^\/api\/logs$/, (c, { q }) => {
    const limit = Math.min(500, num(q.get('limit')) ?? 200);
    const pid = num(q.get('project'));
    const ev = c.db.prepare(`SELECT e.ts, e.kind, e.data, e.run_id AS runId, r.agent, r.project_id AS projectId FROM run_event e JOIN run r ON r.id = e.run_id WHERE e.kind IN ('error','warn','limit','handoff','end') ${pid != null ? 'AND r.project_id = ?' : ''} ORDER BY e.ts DESC LIMIT ?`).all(...(pid != null ? [pid] : []), limit) as unknown as { ts: string; kind: string; data: string; runId: string; agent: string; projectId: number }[];
    const rows: { ts: string; level: string; source: string; message: string; runId?: string; agent?: string }[] = ev.map((e) => {
      const d = JSON.parse(e.data) as Record<string, unknown>;
      const level = e.kind === 'error' ? 'error' : e.kind === 'limit' || e.kind === 'warn' ? 'warn' : 'info';
      const message = e.kind === 'end' ? `run ${String(d['outcome'])}` : e.kind === 'handoff' ? `handoff card ready: ${String(d['id'])}` : String(d['message'] ?? e.kind);
      return { ts: e.ts, level, source: e.kind, message: clip(message, 300), runId: e.runId, agent: e.agent };
    });
    const roots = (pid != null ? [rootOf(c, pid)] : listProjects(c.db).slice(0, 30).map((p) => p.root));
    for (const r of roots) { try { for (const l of readFileSync(join(r, '.hub', 'audit.jsonl'), 'utf8').trim().split('\n').slice(-50)) { const a = JSON.parse(l) as { ts: string; action: string }; rows.push({ ts: a.ts, level: 'audit', source: 'audit', message: `${a.action} ${clip(JSON.stringify({ ...a, ts: undefined, action: undefined }), 120)}` }); } } catch { /* no audit yet */ } }
    return ok(rows.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit));
  }],
  ['GET', /^\/api\/diagram\/(\w+)$/, (c, { params, q }) => {
    const kind = params[0] as Kind;
    if (!KINDS.includes(kind)) return bad(404, 'unknown diagram');
    const fmt = (q.get('format') ?? 'ascii') as Format;
    const pid = num(q.get('project'));
    return ok({ text: render(build(kind, { ...(pid != null ? { root: rootOf(c, pid) } : {}) }), fmt) });
  }],
  ['GET', /^\/api\/skill\/(.+)$/, (c, { params }) => {
    const id = decodeURIComponent(params[0] as string);
    const e = library().find((x) => x.id === id);
    if (!e || e.source.type !== 'local' || !e.source.path) return bad(404, 'not a local skill');
    const p = join(e.source.path, 'SKILL.md');
    if (isSecretPath(p) || !existsSync(p)) return bad(404, 'not found');
    const text = readFileSync(p, 'utf8');
    return ok({ id, frontmatter: parseFrontmatter(text), text: clip(text, 8000) });
  }],
];

export async function handle(c: Ctx, method: string, pathname: string, q: URLSearchParams, body: Body): Promise<Res> {
  for (const [m, re, h] of ROUTES) {
    if (m !== method) continue;
    const mt = re.exec(pathname);
    if (!mt) continue;
    try { return await h(c, { params: mt.slice(1), q, body }); }
    catch (e) { return e instanceof HttpError || e instanceof GateError ? bad(e.status, e.message) : bad(500, 'internal error'); }
  }
  return bad(404, 'no such endpoint');
}
export { ROUTES };
