import type { AgentId } from '../core/types.ts';
import { MODEL_ID } from '../econ/router.ts';
import type { StartReq } from './runner.ts';

/**
 * «Use the leftover limit before it resets» (Phase 7.4, ADR-025). OPT-IN, per project, OFF by default; nothing here starts anything by itself:
 * this file is the pure part (what may be suggested, what a job's run request looks like, whether an agent is on a subscription).
 * The state, the approvals and the tick live in autouse.ts; every run it starts goes through the normal RunManager (worktree branch, review gate, limits, guardrails).
 */
export type JobKind = 'review-existing' | 'missing-tests' | 'graph-refresh';
export interface QueuedJob { id: string; kind: JobKind; projectId: number; agent: AgentId; expectedPct: number; writes: 'none' | 'branch' }
/** A limit reading as the scheduler needs it. `resetsAt` is epoch seconds. `ts` (ISO) is when the reading was taken: a reading older than `MAX_LIMIT_AGE_SEC` is unknown. */
export interface LimitAt { usedPercent: number | null; reached: boolean; resetsAt?: number | null; ts?: string | null }

/** Under this much of the limit left nothing is suggested. */
export const MIN_LEFT_PCT = 20;
/** Only when the reset is at most this many hours away: the leftover is about to be lost. */
export const MAX_HOURS_TO_RESET = 24;
/** A job is only started if, after it, at least this much of the limit would still be left. */
export const SAFETY_MARGIN_PCT = 10;
/** A limit reading older than this says nothing about now. The panel's readings come from runs and the history sync, so they can be old. */
export const MAX_LIMIT_AGE_SEC = 2 * 3600;
/** An approved queue item that has not started within this time is dropped: an approval is not a standing order. */
export const APPROVAL_TTL_MS = 48 * 3600_000;
/** Runs the scheduler may start in 24 hours. */
export const MAX_STARTS_PER_DAY = 3;

export const KINDS: readonly JobKind[] = ['review-existing', 'missing-tests', 'graph-refresh'];
/** What each kind may write: a review writes nothing, new tests go to a worktree branch (never the main folder), the graph refresh writes only graphify-out. */
export const KIND_WRITES: Record<JobKind, 'none' | 'branch'> = { 'review-existing': 'none', 'missing-tests': 'branch', 'graph-refresh': 'none' };
/** graph-refresh is an update of the project graph (ADR-021), not an agent run: it is only ever SUGGESTED here, never started by the scheduler. */
export const STARTABLE: Record<JobKind, boolean> = { 'review-existing': true, 'missing-tests': true, 'graph-refresh': false };
export const KIND_RU: Record<JobKind, string> = { 'review-existing': 'прогнать ревью старого кода', 'missing-tests': 'дописать недостающие тесты в отдельной ветке', 'graph-refresh': 'обновить граф проекта' };

const AGENTS = new Set(['claude', 'codex']);
const isKind = (x: unknown): x is JobKind => typeof x === 'string' && (KINDS as readonly string[]).includes(x);
/** A usable queue entry: known kind and agent, whole project id, a percent in (0, 100], and `writes` exactly what the kind allows (so 'main', or write access for a review, is never accepted from a stored or hostile row). */
export function validJob(x: unknown): x is QueuedJob {
  if (!x || typeof x !== 'object') return false;
  const j = x as Record<string, unknown>;
  return typeof j['id'] === 'string' && j['id'].length > 0 && j['id'].length <= 64 && isKind(j['kind']) && AGENTS.has(j['agent'] as string)
    && typeof j['projectId'] === 'number' && Number.isSafeInteger(j['projectId']) && j['projectId'] > 0
    && typeof j['expectedPct'] === 'number' && Number.isFinite(j['expectedPct']) && j['expectedPct'] > 0 && j['expectedPct'] <= 100
    && (j['writes'] === 'none' || j['writes'] === 'branch') && j['writes'] === KIND_WRITES[j['kind']];
}

/** Share of the limit left, or null when it is not known now: no reading, a nonsense percent, the limit reached, no future reset time, or a reading too old. */
export function leftPct(l: LimitAt | undefined, nowMs: number, maxAgeSec = MAX_LIMIT_AGE_SEC): number | null {
  if (!l || l.reached) return null;
  const used = l.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (typeof l.resetsAt !== 'number' || !Number.isFinite(l.resetsAt) || l.resetsAt * 1000 <= nowMs) return null;
  if (l.ts != null) { const t = Date.parse(l.ts); if (!Number.isFinite(t) || nowMs - t > maxAgeSec * 1000 || t > nowMs + 60_000) return null; }
  return 100 - used;
}

export type Why = 'limit-unknown' | 'too-little-left' | 'reset-far' | 'no-margin';
export interface SuggestIn { limits: Partial<Record<AgentId, LimitAt>>; queue: unknown[]; now: number; marginPct?: number; minLeftPct?: number; maxHours?: number; maxAgeSec?: number }

/** May this job run now, given the budget (percent of the limit still free of earlier jobs)? */
export function eligibility(j: QueuedJob, o: SuggestIn, budget?: number): { ok: true } | { ok: false; why: Why } {
  const l = o.limits[j.agent], left = leftPct(l, o.now, o.maxAgeSec);
  if (left === null) return { ok: false, why: 'limit-unknown' };
  if (left < (o.minLeftPct ?? MIN_LEFT_PCT)) return { ok: false, why: 'too-little-left' };
  const hours = ((l?.resetsAt as number) * 1000 - o.now) / 3600_000;
  if (hours > (o.maxHours ?? MAX_HOURS_TO_RESET)) return { ok: false, why: 'reset-far' };
  if (j.expectedPct + (o.marginPct ?? SAFETY_MARGIN_PCT) > (budget ?? left)) return { ok: false, why: 'no-margin' };
  return { ok: true };
}

/**
 * The jobs that may be offered right now: enough of the limit is left (>= 20 %), the reset is within 24 h, the reading is known and fresh, the job is one of the
 * known low-risk kinds (read-only, or new files on a worktree branch: never write work on the main branch), and after all earlier jobs of the same agent at least
 * the safety margin would still be left. Anything else in the queue (unknown kind, `writes: 'main'`, NaN percent) is dropped. Nothing runs from this list.
 */
export function suggestBeforeReset(o: SuggestIn): QueuedJob[] {
  const budget: Partial<Record<AgentId, number>> = {};
  const out: QueuedJob[] = [];
  for (const j of Array.isArray(o.queue) ? o.queue : []) {
    if (!validJob(j)) continue;
    const left = leftPct(o.limits[j.agent], o.now, o.maxAgeSec);
    const b = budget[j.agent] ?? left ?? 0;
    if (!eligibility(j, o, b).ok) continue;
    budget[j.agent] = b - j.expectedPct;
    out.push(j);
  }
  return out;
}

// ---------- subscription only ----------
/** Variables that make a CLI bill by the token. Any of them set (non-empty) blocks every automatic start, whatever the agent. */
export const BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const PAID_HOW = /api[ _-]?key|token|console|bedrock|vertex|foundry|bearer/i;
const SUBSCRIPTION_HOW: Record<AgentId, RegExp> = { claude: /claude\.ai|oauth|subscription/i, codex: /chatgpt/i };
/**
 * Is this agent clearly on a subscription login, not a pay-per-token key? Fail closed: an unknown or unrecognised way of signing in is NOT accepted.
 * `how` is the CLI's own answer to its status command (`claude auth status`, `codex login status`); the word lists are UNVERIFIED against a signed-in CLI here.
 */
export function billingOk(agent: AgentId, auth: { loggedIn: boolean | null; how: string } | undefined, env: Record<string, string | undefined>): { ok: boolean; why?: string } {
  if (!auth || auth.loggedIn !== true) return { ok: false, why: 'вход в агента не подтверждён' };
  const key = BILLING_ENV.find((k) => (env[k] ?? '').trim() !== '');
  if (key) return { ok: false, why: `в окружении задан ${key}: запуск мог бы идти по оплате за токены` };
  if (PAID_HOW.test(auth.how)) return { ok: false, why: 'агент вошёл по ключу API (оплата за токены)' };
  if (!SUBSCRIPTION_HOW[agent].test(auth.how)) return { ok: false, why: 'не удалось убедиться, что вход по подписке' };
  return { ok: true };
}

// ---------- what a job asks the RunManager for ----------
const REVIEW_PROMPT = 'Read-only review of the EXISTING code of this project (not a diff). Look for bugs that are already there: logic errors, unhandled error paths, unsafe handling of input, races, resource leaks. Start with the riskiest modules and go deep rather than wide. Do not edit, create or delete any file and do not run a command that changes files. Answer as: FINDINGS: file:line — issue (most serious first, at most 20 lines), then SUMMARY: two sentences.';
const TESTS_PROMPT = 'Find the source files changed in the last 7 days (git log --since=7.days --name-only). For those that have no tests, add tests only: new test files or additions to existing test files. Do not change any non-test code. Use the test command the project already has and run it; if the project has no test setup, stop and say so. Keep each test small and about one behaviour.';
const safeId = (s: string): string => (/^[A-Za-z0-9]{1,24}$/.test(s) ? s : 'x');

/**
 * The run request of a job. Fixed prompts (data of this file, never text from a request or a file), no internal-only StartReq field, never `full` permission.
 * A review is `plan` permission with the review work mode (the runner keeps a review thread in plan); new tests are a `task` run: a worktree and a branch `hub/…`,
 * so the main folder is not touched and the result waits for the review gate and the user. `graph-refresh` is not an agent run and throws.
 */
export function startReqFor(j: QueuedJob, projectRoot: string): StartReq {
  if (!STARTABLE[j.kind]) throw new Error(`${j.kind} is not started by the scheduler`);
  const model = j.agent === 'claude' ? { model: MODEL_ID.sonnet } : {};
  if (j.kind === 'review-existing') return { agent: j.agent, prompt: REVIEW_PROMPT, projectRoot, task: `auto-review-${safeId(j.id)}`, permission: 'plan', mode: 'chat', workMode: 'review', cls: 'review', effort: 'high', ...model };
  return { agent: j.agent, prompt: TESTS_PROMPT, projectRoot, task: `auto-tests-${safeId(j.id)}`, permission: 'edit', mode: 'task', workMode: 'task', cls: 'implement', effort: 'high', ...model };
}
