import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectAgents, type AgentInfo } from '../adapters/locate.ts';
import { authStatus, forgetAuth, type AuthInfo } from '../adapters/auth.ts';
import { openLogin, pickFolder } from '../adapters/native.ts';
import { loadMatrix } from '../adapters/probe.ts';
import { applyWorkMode, loadWorkModes } from '../core/workmodes.ts';
import { applyPlan, describe, listBackups, undoBackup } from '../core/plan.ts';
import { planInit, listPacks } from '../core/init.ts';
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
import { calibrate, costUsd, estimate, modelStats, outcomes, PRICES_VERIFIED_AT, profileFromHistory } from '../econ/econ.ts';
import { buildCases, exportCases, NEVER_INCLUDED } from '../econ/cases.ts';
import { startOverhead } from '../econ/overhead.ts';
import { readSessionEvents as readClaudeEvents, syncClaude, type SyncStats } from '../history/claude.ts';
import { readSessionEvents as readCodexEvents, syncCodex } from '../history/codex.ts';
import { resolveSource } from '../history/source.ts';
import { addLimit, getSession, latestLimit, listProjects, listSessions, projectId, search, usageByModel, type Db } from '../history/store.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSecretPath } from '../lib/paths.ts';
import { checkSparse } from '../run/git.ts';
import { RunManager, type StartReq } from '../run/runner.ts';
import { approveStage, stageStatus } from '../stages/engine.ts';

export interface Ctx { db: Db; runs: RunManager; agents?: () => Record<AgentId, AgentInfo>; auth?: (id: AgentId, info: AgentInfo) => AuthInfo; native?: { pickFolder: () => { path: string | null }; openLogin: (id: AgentId, exe: string) => void }; syncDirs?: { claude?: string; codex?: string } }
export interface Res { status: number; json?: unknown }
type Body = Record<string, unknown>;
type Handler = (c: Ctx, p: { params: string[]; q: URLSearchParams; body: Body }) => Res | Promise<Res>;

const ok = (json: unknown): Res => ({ status: 200, json });
const bad = (status: number, error: string): Res => ({ status, json: { error } });
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function rootOf(c: Ctx, id: number | undefined): string {
  const r = id == null ? undefined : (c.db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root;
  if (!r) throw new HttpError(404, 'project not found');
  return r;
}
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

let syncState: { running: boolean; last?: { at: string; claude: SyncStats; codex: SyncStats; ms: number }; error?: string } = { running: false };

function limitState(c: Ctx, agent: AgentId): (LimitState & { resetsAt: number | null; windowMinutes: number | null; source: string; ts: string; stale: boolean; planType: string | null }) | undefined {
  const l = latestLimit(c.db, agent);
  if (!l) return undefined;
  const stale = l.resetsAt != null && l.resetsAt * 1000 < Date.now();
  return { usedPercent: stale ? null : l.usedPercent, reached: !stale && (l.usedPercent ?? 0) >= 100, resetsAt: l.resetsAt, windowMinutes: l.windowMinutes, source: l.source, ts: l.ts, stale, planType: l.planType };
}
/** What the user's own finished runs and preferences add to a model decision. */
const learned = (c: Ctx): { stats: ReturnType<typeof modelStats>; priceWeight: number; explore: number } => { const r = loadUserConfig().routing ?? {}; return { stats: modelStats(c.db), priceWeight: Math.min(5, Math.max(0.2, r.priceWeight ?? 1)), explore: Math.min(0.3, Math.max(0, r.explore ?? 0)) }; };
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
    let plan; try { plan = planInit(root, { type: str(body['type']) ?? hubType ?? 'web-saas', extra: ids('extra'), remove: ids('remove') }); } catch (e) { return bad(400, (e as Error).message); }
    if (params[0] === 'plan') return ok({ lines: describe(plan), notes: plan.notes, missing: plan.missing, selected: plan.selected.map((e) => e.id), changes: plan.changes.map((ch) => ({ path: ch.path.slice(root.length + 1).replace(/\\/g, '/'), action: ch.action, note: ch.note ?? null, before: ch.before === null ? null : clip(ch.before, 3000), after: ch.action === 'link' ? ch.after : clip(ch.after, 3000) })) });
    if (body['approved'] !== true) return bad(400, 'apply needs approved: true');
    const r = applyPlan(plan, { approved: true });
    return ok({ backupId: r.backupId, written: r.written.length, fallbacks: r.fallbacks });
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
      usage, routing: ROUTING, guide: MODEL_GUIDE, pricesVerifiedAt: PRICES_VERIFIED_AT, profile: profileFromHistory(c.db),
    });
  }],
  ['GET', /^\/api\/overhead$/, (c, { q }) => ok(startOverhead(c.db, num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}))],
  ['POST', /^\/api\/runs\/(\w+)\/rating$/, (c, { params, body }) => {
    const r = num(body['rating']);
    if (r == null || ![0, 1, 2].includes(r)) return bad(400, 'rating must be 0 (no), 1 (partly) or 2 (yes)');
    const run = c.runs.get(params[0] as string);
    if (!run) return bad(404, 'run not found');
    if (run.outcome !== 'done' && run.outcome !== 'failed') return bad(400, 'only finished runs can be rated');
    c.db.prepare('UPDATE run SET rating = ? WHERE id = ?').run(r, run.id);
    return ok({ ok: true });
  }],
  ['GET', /^\/api\/routing$/, (c) => { const l = learned(c); const st = Object.values(l.stats).reduce((a, x) => a + x.n, 0); return ok({ priceWeight: l.priceWeight, explore: l.explore, observedRuns: st }); }],
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
  ['GET', /^\/api\/outcomes$/, (c) => ok({ rows: outcomes(c.db) })],
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
    const choice = advise({ cls, ...(body['implementedBy'] === 'claude' || body['implementedBy'] === 'codex' ? { implementedBy: body['implementedBy'] } : {}), ...(body['securityBoundary'] === true ? { securityBoundary: true } : {}), ...(num(body['failures']) != null ? { failures: num(body['failures']) as number } : {}), limits: limitsFor(c), ...learned(c) });
    const est = estimate(profileFromHistory(c.db, choice.agent), choice.model, calibrate(c.db, choice.agent), num(body['scale']) ?? 1);
    return ok({ choice, estimate: est });
  }],

  ['GET', /^\/api\/runs$/, (c, { q }) => ok(c.runs.list({ ...(num(q.get('project')) != null ? { projectId: num(q.get('project')) as number } : {}), limit: Math.min(200, num(q.get('limit')) ?? 50) }).map((r) => ({ ...r, live: c.runs.isLive(r.id) })))],
  ['POST', /^\/api\/runs$/, (c, { body }) => {
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
  ['POST', /^\/api\/runs\/(\w+)\/stop$/, (c, { params }) => ok({ stopped: c.runs.stop(params[0] as string) })],
  ['POST', /^\/api\/runs\/(\w+)\/handoff$/, (c, { params, body }) => {
    const to = body['agent'] === 'claude' || body['agent'] === 'codex' ? body['agent'] : undefined;
    if (!to) return bad(400, 'agent required');
    try { return ok({ run: c.runs.handoff(params[0] as string, { agent: to, ...(str(body['model']) ? { model: str(body['model']) as string } : {}), ...(str(body['effort']) ? { effort: str(body['effort']) as string } : {}) }) }); } catch (e) { return bad(400, (e as Error).message); }
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
    catch (e) { return e instanceof HttpError ? bad(e.status, e.message) : bad(500, 'internal error'); }
  }
  return bad(404, 'no such endpoint');
}
export { ROUTES };
