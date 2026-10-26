import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from the real machine: fake HOME, own hub home.
const fake = mkdtempSync(join(tmpdir(), 'hub-init-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
after(() => { rmSync(fake, { recursive: true, force: true }); });

const { planInit } = await import('./init.ts');
const { applyPlan, undoBackup } = await import('./plan.ts');
const { handle } = await import('../server/api.ts');
const { openDb, projectId } = await import('../history/store.ts');
const { createReview, addFindings } = await import('../review/store.ts');
const { fingerprint } = await import('../review/types.ts');
const { REVIEW_HEADINGS, reviewTemplate } = await import('../review/reviewmd.ts');

const project = (): string => mkdtempSync(join(fake, 'proj-'));
const TYPES = ['web-saas', 'mobile-app', 'automation', 'design-study'];

// ---- init plan -----------------------------------------------------------------------------------------------------------------------

test('init plan for every project type creates REVIEW.md with the five exact headings, in order', () => {
  for (const type of TYPES) {
    const root = project();
    const c = planInit(root, { type }).changes.find((x) => x.path === join(root, 'REVIEW.md'));
    assert.ok(c, `${type}: REVIEW.md change`);
    assert.equal(c.action, 'create'); assert.equal(c.before, null);
    assert.deepEqual([...c.after.matchAll(/^## (.+)$/gm)].map((m) => m[1]), [...REVIEW_HEADINGS], type);
    assert.equal(c.after, reviewTemplate(type));
  }
});

test('an existing REVIEW.md is never overwritten or touched by the init plan', () => {
  const root = project();
  writeFileSync(join(root, 'REVIEW.md'), 'MINE\n');
  const plan = planInit(root, { type: 'web-saas' });
  assert.ok(!plan.changes.some((x) => x.path === join(root, 'REVIEW.md')));
  applyPlan(plan, { approved: true });
  assert.equal(readFileSync(join(root, 'REVIEW.md'), 'utf8'), 'MINE\n');
});

test('apply + undo of the init plan leaves the project as it was (REVIEW.md removed again)', () => {
  const root = project();
  const r = applyPlan(planInit(root, { type: 'automation' }), { approved: true });
  assert.ok(readFileSync(join(root, 'REVIEW.md'), 'utf8').includes('## Не проверять'));
  assert.equal(planInit(root, { type: 'automation' }).changes.some((x) => x.path === join(root, 'REVIEW.md')), false, 'idempotent');
  undoBackup(root, r.backupId);
  assert.deepEqual(readdirSync(root).filter((f) => f !== '.hub'), []);
});

// ---- review-rules API ----------------------------------------------------------------------------------------------------------------

function world(): { db: ReturnType<typeof openDb>; root: string; pid: number; api: (m: string, p: string, body?: Record<string, unknown>) => ReturnType<typeof handle> } {
  const db = openDb(':memory:'); const root = project();
  const pid = projectId(db, root) as number;
  const real = (db.prepare('SELECT root FROM project WHERE id = ?').get(pid) as { root: string }).root;
  const api = (m: string, p: string, body: Record<string, unknown> = {}) => { const [path, qs] = p.split('?'); return handle({ db } as never, m, path!, new URLSearchParams(qs ?? ''), body); };
  return { db, root: real, pid, api };
}
const seed = (db: ReturnType<typeof openDb>, pid: number, cls: string, times: number): void => {
  const rv = createReview(db, { runId: `r${cls}${times}`, projectId: pid, baseSha: 'a', headSha: 'b', effort: 'standard', risk: 'medium', round: 1, state: 'open' });
  addFindings(db, rv.id, 1, Array.from({ length: times }, (_, i) => { const r = { lens: 'correctness' as const, file: `f${i}.ts`, line: 1, title: `t${i}`, evidence: 'e', classOfBug: cls, category: 'bug' as const }; return { ...r, severity: 'important' as const, fingerprint: fingerprint(r, `x${i}${cls}`), votes: { real: 2, notReal: 0 } }; }));
};

test('GET review-rules offers a class seen 3 times with a rule line, not one seen twice', async () => {
  const w = world(); seed(w.db, w.pid, 'null-deref', 3); seed(w.db, w.pid, 'rare', 2);
  const r = await w.api('GET', `/api/projects/${w.pid}/review-rules`);
  assert.equal(r.status, 200);
  const j = r.json as { repeated: { classOfBug: string; count: number; line: string }[]; hasReviewMd: boolean };
  assert.deepEqual(j.repeated.map((x) => [x.classOfBug, x.count]), [['null-deref', 3]]);
  assert.ok(j.repeated[0]!.line.includes('null-deref') && !j.repeated[0]!.line.includes('\n'));
  assert.equal(j.hasReviewMd, false);
  assert.equal((await w.api('GET', '/api/projects/999/review-rules')).status, 404);
  assert.equal((await w.api('GET', '/api/projects/abc/review-rules')).status, 404);
});

test('POST review-rules: refuses without approval, with a multi-line or oversized line, and without REVIEW.md; writes nothing', async () => {
  const w = world();
  writeFileSync(join(w.root, 'REVIEW.md'), reviewTemplate('web-saas') as string);
  const before = readFileSync(join(w.root, 'REVIEW.md'), 'utf8');
  const url = `/api/projects/${w.pid}/review-rules`;
  assert.equal((await w.api('POST', url, { line: 'правило' })).status, 400);
  assert.equal((await w.api('POST', url, { line: 'правило', approved: 'yes' })).status, 400);
  assert.equal((await w.api('POST', url, { line: 'a\nb', approved: true })).status, 400);
  assert.equal((await w.api('POST', url, { line: 'x'.repeat(301), approved: true })).status, 400);
  assert.equal((await w.api('POST', url, { approved: true })).status, 400);
  assert.equal((await w.api('POST', url, { line: ['x'], approved: true })).status, 400);
  assert.equal(readFileSync(join(w.root, 'REVIEW.md'), 'utf8'), before);
  assert.equal(existsBackups(w.root), false);
  const w2 = world();
  assert.equal((await w2.api('POST', `/api/projects/${w2.pid}/review-rules`, { line: 'x', approved: true })).status, 400, 'no REVIEW.md');
});
const existsBackups = (root: string): boolean => { try { return readdirSync(join(root, '.hub', 'backups')).length > 0; } catch { return false; } };

test('POST review-rules: preview shows the change and writes nothing; approved appends under the heading with a backup; undo restores it', async () => {
  const w = world();
  writeFileSync(join(w.root, 'REVIEW.md'), reviewTemplate('web-saas') as string);
  const before = readFileSync(join(w.root, 'REVIEW.md'), 'utf8');
  const url = `/api/projects/${w.pid}/review-rules`;
  const pv = await w.api('POST', url, { line: 'Проверять права на каждом запросе', preview: true });
  assert.equal(pv.status, 200);
  const pj = pv.json as { changes: { path: string; action: string; after: string }[] };
  assert.equal(pj.changes.length, 1); assert.equal(pj.changes[0]!.path, 'REVIEW.md'); assert.match(pj.changes[0]!.after, /- Проверять права на каждом запросе/);
  assert.equal(readFileSync(join(w.root, 'REVIEW.md'), 'utf8'), before, 'preview writes nothing');

  const done = await w.api('POST', url, { line: 'Проверять права на каждом запросе', approved: true });
  assert.equal(done.status, 200);
  const after = readFileSync(join(w.root, 'REVIEW.md'), 'utf8');
  assert.ok(after.indexOf('- Проверять права') > after.indexOf('## Что здесь считается поломкой') && after.indexOf('- Проверять права') < after.indexOf('## Не проверять'));
  assert.equal((await w.api('POST', url, { line: 'Проверять права на каждом запросе', approved: true })).status, 409, 'same rule twice');
  const backupId = (done.json as { backupId: string }).backupId;
  assert.ok(backupId);
  const undo = await w.api('POST', '/api/undo', { projectId: w.pid, backupId });
  assert.equal(undo.status, 200);
  assert.equal(readFileSync(join(w.root, 'REVIEW.md'), 'utf8'), before, 'undo restores the file');
});
