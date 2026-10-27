import { existsSync } from 'node:fs';
import { loadUserConfig } from '../core/registry.ts';
import { projectForecast } from '../econ/forecast-data.ts';
import type { Ctx, Handler, Res } from './api.ts';

/**
 * Routes of Phase 7 tasks 7.3-7.5 (kept out of api.ts so that file only gains one import and one spread). Type-only imports from api.ts: nothing circular at run time.
 * Same session cookie, Host and Origin checks as every route (server.ts); nothing here reads a path from a request.
 */
const ok = (json: unknown): Res => ({ status: 200, json });
const bad = (status: number, error: string): Res => ({ status, json: { error } });
const rootOfProject = (c: Ctx, id: number): string | undefined => (c.db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root;

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
];
