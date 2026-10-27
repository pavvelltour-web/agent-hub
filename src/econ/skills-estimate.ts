import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { skillRoots } from '../core/registry.ts';

/**
 * The size of the skill list an agent loads at the start of a session (the loading audit's estimate), for the context gauge (ADR-024).
 * The audit reads every SKILL.md and takes about a second on a big library, so it must never run on the request path: `peek` answers at once with the
 * last known value (or null before the first one) and, when nothing is known yet or the library changed (`fingerprint`), starts ONE refresh in the background
 * (a worker thread by default, so the server keeps answering). It never recomputes per poll: the fingerprint is checked at most every `checkEveryMs`.
 * A failed or hung refresh keeps the old value and is not retried for a minute. At most `max` roots are kept; the least recently asked goes first.
 */
export interface SkillsEstimator { peek(root: string, agent: 'claude' | 'codex'): number | null; size(): number }
type Totals = { claude: number; codex: number };
interface Entry { value: Totals | null; fp: string; checkedAt: number; retryAt: number; inflight: boolean }

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function createSkillsEstimator(o: { compute: (root: string) => Promise<Totals>; fingerprint: (root: string) => string; max?: number; checkEveryMs?: number; timeoutMs?: number }): SkillsEstimator {
  const cache = new Map<string, Entry>(), max = o.max ?? 50, every = o.checkEveryMs ?? 10_000, timeout = o.timeoutMs ?? 30_000;
  const refresh = (e: Entry, root: string, fp: string): void => {
    e.inflight = true;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeout); timer.unref?.(); });
    Promise.race([o.compute(root), limit]).then((v) => { e.value = { claude: n(v?.claude), codex: n(v?.codex) }; e.fp = fp; }, () => { e.retryAt = Date.now() + 60_000; })
      .finally(() => { clearTimeout(timer); e.inflight = false; });
  };
  return {
    size: () => cache.size,
    peek(root, agent) {
      let e = cache.get(root);
      if (e) { cache.delete(root); cache.set(root, e); }   // least-recently-asked order
      else { e = { value: null, fp: '', checkedAt: 0, retryAt: 0, inflight: false }; cache.set(root, e); while (cache.size > max) cache.delete(cache.keys().next().value as string); }
      const now = Date.now();
      if (!e.inflight && now >= e.retryAt && (e.value === null || now - e.checkedAt >= every)) {
        let fp = 'unreadable'; try { fp = o.fingerprint(root); } catch { /* an unreadable library has a fingerprint of its own */ }
        e.checkedAt = now;
        if (e.value === null || fp !== e.fp) refresh(e, root, fp);
      }
      return e.value ? e.value[agent] : null;
    },
  };
}

/** Cheap change detector: the time and size of every skill folder's entry and of the files that switch skills on and off. A few hundred `stat` calls at most. */
export function skillsFingerprint(root: string): string {
  const parts: string[] = [];
  const st = (p: string): void => { try { const s = statSync(p); parts.push(`${p}:${s.mtimeMs}:${s.size}`); } catch { parts.push(`${p}:-`); } };
  for (const r of skillRoots(root)) {
    st(r);
    let names: string[] = []; try { names = readdirSync(r).slice(0, 2000); } catch { /* none */ }
    for (const name of names) st(join(r, name, 'SKILL.md'));
  }
  for (const f of [join(root, '.claude', 'settings.local.json'), join(root, '.codex', 'config.toml'), join(homedir(), '.codex', 'config.toml'), join(root, '.mcp.json'), join(root, 'hub.json')]) st(f);
  return parts.join('|');
}

/** Runs the audit in a worker thread (a file next to this one; `.ts` when this module runs from source, `.js` when built). Hard-stopped after `timeoutMs`. */
export function workerCompute(root: string, timeoutMs = 30_000): Promise<Totals> {
  return new Promise((resolve, reject) => {
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const w = new Worker(new URL(`./skills-worker${ext}`, import.meta.url), { workerData: { root }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const t = setTimeout(() => { void w.terminate(); reject(new Error('timeout')); }, timeoutMs); t.unref?.();
    w.once('message', (m: Totals) => { clearTimeout(t); resolve(m); void w.terminate(); });
    w.once('error', (e) => { clearTimeout(t); reject(e); });
    w.once('exit', () => { clearTimeout(t); reject(new Error('worker exited')); });   // after a message this rejects an already-settled promise: harmless
    w.unref();
  });
}

let shared: SkillsEstimator | undefined;
/** The estimator the server uses: worker thread, fingerprint of the skill folders. */
export const sharedSkillsEstimator = (): SkillsEstimator => (shared ??= createSkillsEstimator({ compute: (root) => workerCompute(root), fingerprint: skillsFingerprint }));
