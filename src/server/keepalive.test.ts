import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-keepalive-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const db = openDb(':memory:');
const srv = await startServer({ db, runs: new RunManager(db, { summarize: false }) } as never);
after(async () => { await srv.close(); try { rmSync(fake, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });

// Handlers call git with spawnSync (up to 60 s, src/run/git.ts) in the same process that holds the sockets. While the loop is stalled, Node's 5 s keep-alive timer
// expires; on resume the server closes the idle socket before it reads the request already waiting on it, and the client gets ECONNRESET (observed: server-side close
// 2-11 ms after each 4-12 s stall, GET /api/runs/<id>/cascade failed after 3 ms). The window must outlast the longest stall.
test('the keep-alive window outlasts the longest synchronous stall of a handler (git timeout 60 s)', () => {
  assert.ok(srv.server.keepAliveTimeout > 60_000, `keepAliveTimeout is ${srv.server.keepAliveTimeout} ms`);
});
