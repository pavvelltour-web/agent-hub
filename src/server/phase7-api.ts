import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectAgents } from '../adapters/locate.ts';
import { authStatus } from '../adapters/auth.ts';
import { loadUserConfig, saveUserConfig } from '../core/registry.ts';
import type { AgentId } from '../core/types.ts';
import { calibrate, estimate, profileFromHistory } from '../econ/econ.ts';
import { projectForecast } from '../econ/forecast-data.ts';
import { limitSnapshots } from '../econ/limits.ts';
import { MODEL_ID } from '../econ/router.ts';
import { guardrails, reviewWindow } from '../review/guardrails.ts';
import { CAP_RANGE, DEFAULT_CAPS, NUM_KEYS, DAY_MS, ackTrip, auditGuard, capsProblem, effectiveCaps, evaluate, loadAcks, readFacts, sanitizeCaps, userCapsRaw } from '../run/breaker.ts';
import { approveItem, cancelItem, confirmWordFor, isEnabled, loadAuto, newItemId, projectKeyOf, setEnabled, type AutoItem } from '../run/autouse.ts';
import { APPROVAL_TTL_MS, KIND_RU, KIND_WRITES, MAX_HOURS_TO_RESET, MAX_STARTS_PER_DAY, MIN_LEFT_PCT, SAFETY_MARGIN_PCT, STARTABLE, billingOk, leftPct, suggestBeforeReset, type JobKind, type LimitAt, type QueuedJob } from '../run/scheduler.ts';
import type { Ctx, Handler, Res } from './api.ts';

/**
 * Routes of Phase 7 tasks 7.3-7.5 (kept out of api.ts so that file only gains one import and one spread). Type-only imports from api.ts: nothing circular at run time.
 * Same session cookie, Host and Origin checks as every route (server.ts); nothing here reads a path from a request. A POST that changes what the hub may do on its own
 * (7.4, 7.5) also needs `meta.userAction`: a same-origin Origin and the panel's own header (server.ts), so a script that only has the cookie cannot flip it.
 */
const ok = (json: unknown): Res => ({ status: 200, json });
const bad = (status: number, error: string): Res => ({ status, json: { error } });
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const rootOfProject = (c: Ctx, id: number): string | undefined => (c.db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root;
const needClick = bad(403, 'this needs a click in the panel');

const isJobKind = (x: unknown): x is JobKind => typeof x === 'string' && Object.prototype.hasOwnProperty.call(KIND_RU, x);
const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };
const REASON_RU = { unknown: 'лимит сейчас неизвестен или данные устарели', little: `осталось меньше ${MIN_LEFT_PCT} %`, far: `до сброса больше ${MAX_HOURS_TO_RESET} ч`, margin: `не хватит запаса в ${SAFETY_MARGIN_PCT} %`, estimate: 'нет замеров, сколько это съест' };

/** Share of the weekly limit one run of this agent is expected to use: the cautious end (p75) of the range. null = not known. */
function jobPct(c: Ctx, agent: AgentId): number | null {
  const model = agent === 'claude' ? MODEL_ID.sonnet : 'gpt-6.1-sol';
  const e = estimate(profileFromHistory(c.db, agent), model, calibrate(c.db, agent), 1);
  const p = e.percent?.high;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? Math.min(100, Math.max(1, Math.ceil(p))) : null;
}
const itemView = (i: AutoItem) => ({ id: i.id, kind: i.kind, kindRu: KIND_RU[i.kind], agent: i.agent, expectedPct: i.expectedPct, status: i.status, approvedAt: i.approvedAt, startedAt: i.startedAt ?? null, runId: i.runId ?? null, outcome: i.outcome ?? null, note: i.note ? clip(i.note, 200) : null });

interface Suggestion { kind: JobKind; agent: AgentId; expectedPct: number; titleRu: string; leftPct: number; hoursToReset: number; writes: 'none' | 'branch' }
function projectAuto(c: Ctx, p: { id: number; root: string; slug: string }, st: ReturnType<typeof loadAuto>, now: number) {
  const enabled = isEnabled(st, p.root), key = projectKeyOf(p.root);
  const snaps = limitSnapshots(c.db, now);
  const limits: Partial<Record<AgentId, LimitAt>> = {};
  for (const a of ['claude', 'codex'] as AgentId[]) { const l = snaps[a]; if (l) limits[a] = { usedPercent: l.usedPercent, reached: l.reached, resetsAt: l.resetsAt, ts: l.ts }; }
  const info = (c.agents ?? detectAgents)();
  const suggestions: Suggestion[] = [];
  const blocked: { agent: AgentId; why: string }[] = [];
  if (enabled) {
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      const bill = billingOk(agent, info[agent].installed ? (c.auth ?? authStatus)(agent, info[agent]) : undefined, process.env);
      if (!bill.ok) { blocked.push({ agent, why: bill.why ?? 'подписка не подтверждена' }); continue; }
      const pct = jobPct(c, agent);
      if (pct == null) { blocked.push({ agent, why: REASON_RU.estimate }); continue; }
      const queue: QueuedJob[] = (Object.keys(KIND_RU) as JobKind[]).filter((k) => STARTABLE[k]).map((kind) => ({ id: `s-${agent}-${kind}`, kind, projectId: p.id, agent, expectedPct: pct, writes: KIND_WRITES[kind] }));
      // what the user already approved (or is running) is not offered again
      const taken = (j: QueuedJob): boolean => st.items.some((i) => i.projectKey === key && i.kind === j.kind && i.agent === agent && (i.status === 'approved' || i.status === 'started'));
      const fit = suggestBeforeReset({ limits, queue: queue.filter((j) => !taken(j)), now });
      const l = limits[agent], left = leftPct(l, now);
      if (!fit.length) { blocked.push({ agent, why: left == null ? REASON_RU.unknown : left < MIN_LEFT_PCT ? REASON_RU.little : ((l?.resetsAt ?? 0) * 1000 - now) / 3600_000 > MAX_HOURS_TO_RESET ? REASON_RU.far : REASON_RU.margin }); continue; }
      for (const j of fit) suggestions.push({ kind: j.kind, agent, expectedPct: j.expectedPct, titleRu: `${AGENT_NAMES[agent]}: ${KIND_RU[j.kind]}`, leftPct: left as number, hoursToReset: Math.round(((((l as LimitAt).resetsAt as number) * 1000 - now) / 3600_000) * 10) / 10, writes: j.writes });
    }
  }
  const items = st.items.filter((i) => i.projectKey === key).slice(-12).map(itemView);
  return { projectId: p.id, slug: p.slug, enabled, since: st.projects[key]?.at ?? null, confirmWord: confirmWordFor(p.root), suggestions, blocked, items };
}

/** An append-only line in the hub home for every switch the user flips here (what, which folder, when). */
function audit(c: Ctx, e: Record<string, unknown>): void {
  try { mkdirSync(c.runs.home, { recursive: true }); appendFileSync(join(c.runs.home, 'autouse-audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); } catch { /* the audit line is best effort */ }
}

export const phase7Routes: [string, RegExp, Handler][] = [
  // 7.3: pure computation over the project's tasks files and the user's own finished runs; writes nothing.
  ['GET', /^\/api\/projects\/(\d+)\/forecast$/, (c, { params }) => {
    const root = rootOfProject(c, Number(params[0]));
    if (!root) return bad(404, 'project not found');
    if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    const r = projectForecast(c.db, root, { priceWeight: Math.min(5, Math.max(0.2, loadUserConfig().routing?.priceWeight ?? 1)) });
    const t = r.tasks;
    return ok({ enough: r.forecast.enough, reason: r.forecast.reason, tasks: { open: t.tasks.length, done: t.done, total: t.total, guessed: t.guessed, truncated: t.truncated, files: t.files }, forecast: r.forecast, sampleRuns: r.sampleRuns });
  }],

  // 7.4 (ADR-025): the leftover-limit scheduler. OPT-IN per project, OFF by default. Every POST needs a user click (`meta.userAction`) on top of the cookie, Host and Origin checks.
  ['GET', /^\/api\/autouse$/, (c, { q }) => {
    const now = Date.now(), st = loadAuto(c.runs.home);
    const one = q.get('project') != null && /^\d+$/.test(q.get('project') as string) ? Number(q.get('project')) : null;
    const rows = c.db.prepare('SELECT id, root, slug FROM project ORDER BY id').all() as unknown as { id: number; root: string; slug: string }[];
    const mine = rows.filter((p) => (one != null ? p.id === one : isEnabled(st, p.root))).slice(0, 30);
    if (one != null && !mine.length) return bad(404, 'project not found');
    return ok({ now, settings: { minLeftPct: MIN_LEFT_PCT, marginPct: SAFETY_MARGIN_PCT, maxHoursToReset: MAX_HOURS_TO_RESET, approvalHours: APPROVAL_TTL_MS / 3600_000, maxStartsPerDay: MAX_STARTS_PER_DAY, loop: 'только пока открыта панель hub' },
      projects: mine.map((p) => projectAuto(c, p, st, now)) });
  }],
  ['POST', /^\/api\/autouse\/enable$/, (c, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const id = typeof body['projectId'] === 'number' ? body['projectId'] : NaN;
    const root = Number.isSafeInteger(id) ? rootOfProject(c, id) : undefined;
    if (!root) return bad(404, 'project not found');
    if (typeof body['enabled'] !== 'boolean') return bad(400, 'enabled: true or false');
    if (body['enabled']) {
      if (typeof body['confirm'] !== 'string' || body['confirm'].normalize('NFC').trim() !== confirmWordFor(root)) return bad(400, 'type the folder name of the project to confirm');
      if (!existsSync(root)) return bad(400, 'project folder is missing on disk');
    }
    try { setEnabled(c.runs.home, root, body['enabled'], Date.now()); } catch (e) { return bad(400, (e as Error).message); }
    audit(c, { action: body['enabled'] ? 'autouse-enable' : 'autouse-disable', root });
    return ok({ enabled: body['enabled'] });
  }],
  ['POST', /^\/api\/autouse\/approve$/, (c, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const id = typeof body['projectId'] === 'number' ? body['projectId'] : NaN;
    const root = Number.isSafeInteger(id) ? rootOfProject(c, id) : undefined;
    if (!root) return bad(404, 'project not found');
    const kind = body['kind'], agent = body['agent'];
    if (!isJobKind(kind) || !STARTABLE[kind]) return bad(400, 'unknown or non-startable kind');
    if (agent !== 'claude' && agent !== 'codex') return bad(400, 'agent must be claude or codex');
    const st = loadAuto(c.runs.home);
    if (!isEnabled(st, root)) return bad(409, 'switch this project on first');
    const now = Date.now();
    // the job is built HERE from the kind and the agent: the percent, the writes and the prompt never come from the request
    const offer = projectAuto(c, { id, root, slug: '' }, st, now).suggestions.find((s) => s.kind === kind && s.agent === agent);
    if (!offer) return bad(409, 'not available now: the limit, the reset time or the subscription check does not allow it');
    try {
      const item = approveItem(c.runs.home, { id: newItemId(), kind, projectId: id, agent, expectedPct: offer.expectedPct, writes: KIND_WRITES[kind] }, root, now);
      audit(c, { action: 'autouse-approve', root, kind, agent });
      return ok({ item: itemView(item) });
    } catch (e) { return bad(400, (e as Error).message); }
  }],
  ['POST', /^\/api\/autouse\/cancel$/, (c, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const id = typeof body['id'] === 'string' && /^au[0-9a-f]{8}$/.test(body['id']) ? body['id'] : undefined;
    if (!id) return bad(400, 'bad id');
    return cancelItem(c.runs.home, id) ? ok({ cancelled: true }) : bad(404, 'nothing to cancel');
  }],
  // ---- 7.5 (ADR-026): guardrails, the circuit breaker. Reading is open to the panel; every change needs a user click, like 7.4. A project's hub.json is never consulted here.
  ['GET', /^\/api\/guardrails$/, (c) => {
    const now = Date.now(), { caps } = effectiveCaps(userCapsRaw());
    const facts = readFacts(c.db, now), day = facts.filter((f) => now - f.startedMs < DAY_MS);
    const slug = (id: number | undefined): string => (id == null ? '' : (c.db.prepare('SELECT slug FROM project WHERE id = ?').get(id) as { slug: string } | undefined)?.slug ?? '');
    const win = reviewWindow(c.db, now), g = guardrails(win);
    const nums = (x: Record<string, unknown>): Record<string, number> => Object.fromEntries(NUM_KEYS.map((k) => [k, x[k] as number]));
    return ok({
      enabled: caps.enabled, caps: nums(caps as unknown as Record<string, unknown>), defaults: nums(DEFAULT_CAPS as unknown as Record<string, unknown>), ranges: Object.fromEntries(NUM_KEYS.map((k) => [k, { min: CAP_RANGE[k][0], max: CAP_RANGE[k][1] }])),
      usage: { dayWeighted: Math.round(day.reduce((a, f) => a + f.w, 0) * 100) / 100, dayUsd: Math.round(day.reduce((a, f) => a + (f.usd ?? 0), 0) * 100) / 100 },
      trips: evaluate({ now, facts, caps, acks: loadAcks(c.runs.home) }).slice(0, 8).map((t) => ({ kind: t.kind, key: t.key, ru: t.ru, blocksStart: t.blocksStart, ackable: t.ackable, ...(t.projectId != null ? { projectId: t.projectId, slug: slug(t.projectId) } : {}) })),
      review: { reviewEffort: g.reviewEffort, humanFromTier: g.humanFromTier, why: g.why, note: g.note, flagReviewer: g.flagReviewer, tightened: g.tightened, window: win },
    });
  }],
  ['POST', /^\/api\/guardrails$/, (c, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const cfg = loadUserConfig(), cur = (cfg.guardrails ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...sanitizeCaps(cur), ...(cur['enabled'] === false ? { enabled: false } : {}) };
    let did = '';
    if (body['reset'] === true) { for (const k of Object.keys(next)) delete next[k]; did = 'reset'; }
    if (body['caps'] !== undefined) {
      const problem = capsProblem(body['caps']);
      if (problem) return bad(400, problem);
      Object.assign(next, body['caps'] as Record<string, number>); did = did ? did + '+caps' : 'caps';
    }
    if (body['enabled'] === false) {
      // the one dangerous change: it needs the typed word on top of the click
      if (typeof body['confirm'] !== 'string' || body['confirm'].trim() !== 'ВЫКЛЮЧИТЬ') return bad(400, 'type ВЫКЛЮЧИТЬ to switch the protection off');
      next['enabled'] = false; did = did ? did + '+off' : 'off';
    } else if (body['enabled'] === true) { delete next['enabled']; did = did ? did + '+on' : 'on'; }
    else if (body['enabled'] !== undefined) return bad(400, 'enabled: true or false');
    if (!did) return bad(400, 'nothing to change: send caps, enabled or reset');
    saveUserConfig({ ...cfg, guardrails: next });
    auditGuard(c.runs.home, { action: `guardrails-${did}`, ...(body['caps'] !== undefined ? { caps: body['caps'] } : {}) });
    return ok({ ok: true });
  }],
  ['POST', /^\/api\/guardrails\/ack$/, (c, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const key = typeof body['key'] === 'string' ? body['key'] : '';
    if (!ackTrip(c.runs.home, key, Date.now())) return bad(400, 'only a repeated failure or repeated stops can be acknowledged');
    auditGuard(c.runs.home, { action: 'guardrails-ack', key });
    return ok({ ok: true });
  }],
];
