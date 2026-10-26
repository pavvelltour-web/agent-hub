// Smoke test on the real machine: import both histories into a throwaway DB, print counts and timing.
import { openDb, listProjects, usageByModel, latestLimit, search } from '../src/history/store.ts';
import { syncClaude } from '../src/history/claude.ts';
import { syncCodex } from '../src/history/codex.ts';

const dbPath = process.argv[2] ?? ':memory:';
const db = openDb(dbPath);
let t = Date.now();
const c = await syncClaude(db);
console.log('claude', c, `${((Date.now() - t) / 1000).toFixed(1)}s`);
t = Date.now();
const x = await syncCodex(db);
console.log('codex', x, `${((Date.now() - t) / 1000).toFixed(1)}s`);
t = Date.now();
const again = await syncCodex(db);
console.log('codex re-sync', again, `${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log('projects', listProjects(db).slice(0, 8).map((p) => `${p.slug}: ${p.claude}c/${p.codex}x`));
console.log('models', usageByModel(db).slice(0, 5).map((m) => `${m.model} ${m.agent} sessions=${m.sessions}`));
console.log('codex limit', latestLimit(db, 'codex'));
t = Date.now();
console.log('search "graphify"', search(db, 'graphify', { limit: 3 }).map((h) => `${h.agent}:${h.title?.slice(0, 40)}`), `${Date.now() - t}ms`);
