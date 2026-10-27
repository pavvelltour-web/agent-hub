import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT } from '../core/registry.ts';
import { safeJoin } from '../lib/paths.ts';
import { handle, type Ctx } from './api.ts';
import { sweepReviewerDirs } from '../review/agents.ts';
import { sweepCheckRuns } from '../review/checks.ts';
import { markInterruptedReviews } from '../review/store.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 1_000_000;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface Started { server: Server; port: number; token: string; url: string; close: () => Promise<void>; warnings: string[] }

const eqToken = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (req: IncomingMessage, name: string): string | undefined => req.headers.cookie?.split(/;\s*/).map((p) => p.split('=')).find(([k]) => k === name)?.[1];

/**
 * Local server. Defences: loopback only; Host must be 127.0.0.1/localhost:<port> (DNS rebinding); session token in an HttpOnly SameSite=Strict
 * cookie, set by visiting `/?t=<token>` once; state-changing requests also need a same-origin Origin; JSON bodies capped; static files confined to web/.
 */
export async function startServer(ctx: Ctx, o: { port?: number; token?: string; webDir?: string } = {}): Promise<Started> {
  // This process runs the review rounds: one left mid-round by a crash is open again ("interrupted by a restart"); old reviewer folders go.
  markInterruptedReviews(ctx.db);
  const warnings = [...sweepReviewerDirs(ctx.runs.home), ...sweepCheckRuns(ctx.runs.home)];
  for (const w of warnings) process.stderr.write(`agent-hub: ${w}
`);
  const token = o.token ?? randomBytes(24).toString('base64url');
  const webDir = o.webDir ?? join(REPO_ROOT, 'web');
  let port = 0;
  const hostOk = (h: string | undefined): boolean => !!h && [`127.0.0.1:${port}`, `localhost:${port}`].includes(h.toLowerCase());
  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'application/json', extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP, ...extra });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return send(res, 403, JSON.stringify({ error: 'bad host' }));
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const method = req.method ?? 'GET';
      // Entry point: ?t=<token> sets the cookie and redirects, so the token never stays in the address bar or history.
      if (method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!eqToken(url.searchParams.get('t') ?? '', token)) return send(res, 403, JSON.stringify({ error: 'bad token' }));
        return send(res, 302, '', 'text/plain', { location: '/', 'set-cookie': `hub_token=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      const authed = eqToken(cookieOf(req, 'hub_token') ?? '', token);
      if (url.pathname.startsWith('/api/')) {
        if (!authed) return send(res, 401, JSON.stringify({ error: 'unauthorized: open the URL printed by `hub ui`' }));
        if (method !== 'GET') {
          const origin = req.headers.origin;
          if (origin && !hostOk(origin.replace(/^https?:\/\//, ''))) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
          if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return send(res, 415, JSON.stringify({ error: 'JSON only' }));
        }
        const sse = /^\/api\/runs\/(\w+)\/stream$/.exec(url.pathname);
        if (sse && method === 'GET') return stream(ctx, sse[1] as string, Number(url.searchParams.get('after') ?? 0), req, res);
        let body: Record<string, unknown> = {};
        if (method !== 'GET') {
          const chunks: Buffer[] = []; let n = 0;
          for await (const ch of req) { n += (ch as Buffer).length; if (n > MAX_BODY) return send(res, 413, JSON.stringify({ error: 'body too large' })); chunks.push(ch as Buffer); }
          try { body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}; } catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
        }
        const r = await handle(ctx, method, url.pathname, url.searchParams, body);
        if (r.text !== undefined) return send(res, r.status, r.text, r.type ?? 'text/plain; charset=utf-8', r.headers ?? {});
        return send(res, r.status, JSON.stringify(r.json ?? {}));
      }
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
      if (!authed) return send(res, 401, '<!doctype html><meta charset=utf-8><title>agent hub</title><p style="font:16px system-ui;padding:2rem">Откройте адрес, который напечатала команда <code>hub ui</code> (в нём одноразовый токен).</p>', 'text/html; charset=utf-8');
      // Static files, confined to web/ (traversal guarded).
      const rel = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      let file: string;
      try { file = safeJoin(webDir, rel); } catch { return send(res, 403, JSON.stringify({ error: 'forbidden' })); }
      if (!existsSync(file) || !statSync(file).isFile()) { file = join(webDir, 'index.html'); }
      if (!existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, method === 'HEAD' ? '' : readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', { 'cache-control': extname(file) === '.woff2' ? 'max-age=86400' : 'no-store' });
    } catch { return send(res, 500, JSON.stringify({ error: 'internal error' })); }
  });

  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  return { server, port, token, url: `http://127.0.0.1:${port}/?t=${token}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }), warnings };
}

function stream(ctx: Ctx, runId: string, after: number, req: IncomingMessage, res: ServerResponse): void {
  if (!ctx.runs.get(runId)) { res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"run not found"}'); }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  let last = after;
  const write = (e: { seq: number; ts: string; kind: string; data: unknown }): void => { if (e.seq <= last) return; last = e.seq; res.write(`id: ${e.seq}\nevent: ${e.kind === 'end' ? 'end' : 'ev'}\ndata: ${JSON.stringify(e)}\n\n`); };
  const unsub = ctx.runs.subscribe(runId, write);     // subscribe first, then replay: nothing is lost between the two
  for (const e of ctx.runs.events(runId, after)) write(e);
  if (!ctx.runs.isLive(runId)) { unsub(); return void res.end(); }
  const ka = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  req.on('close', () => { clearInterval(ka); unsub(); });
  const un2 = ctx.runs.subscribe(runId, (e) => { if (e.kind === 'end') { clearInterval(ka); unsub(); un2(); res.end(); } });
}
