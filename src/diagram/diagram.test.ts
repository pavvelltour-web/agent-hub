import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, parseSchema, render, ARCH } from './index.ts';
import { REPO_ROOT } from '../core/registry.ts';

test('data diagram comes from the real SQL schema (tables, columns, references)', () => {
  const t = parseSchema();
  const names = t.map((x) => x.name);
  for (const n of ['session', 'message', 'usage_event', 'limit_snapshot', 'run', 'run_event', 'project']) assert.ok(names.includes(n), n);
  assert.equal(t.find((x) => x.name === 'message')!.cols.find((c) => c.name === 'session_id')!.ref, 'session');
  const ascii = render(build('data'), 'ascii');
  assert.match(ascii, /session_id\s+TEXT\s+→ session/);
  const m = render(build('data'), 'mermaid');
  assert.match(m, /^```mermaid\nflowchart LR/); assert.match(m, /message -->\|session_id\| session/);
  assert.deepEqual(Object.keys(JSON.parse(render(build('data', { entity: 'session' }), 'json'))), ['title', 'sections', 'graph']);
});

test('arch/stages/routing render in all three formats', () => {
  for (const k of ['arch', 'stages', 'routing'] as const) for (const f of ['ascii', 'mermaid', 'json'] as const) assert.ok(render(build(k), f).length > 50, `${k}/${f}`);
  assert.match(render(build('routing'), 'ascii'), /implement\s+→ claude-sonnet-5-5\s+medium/);
  assert.match(render(build('stages'), 'ascii'), /1 Идея и контекст ─► 2 Вопросы к вам/);
});

test('--check: the repo is in sync; drift in generated docs and an unlisted src folder are reported', () => {
  assert.deepEqual(check(REPO_ROOT, true), [], 'write mode regenerates');
  assert.deepEqual(check(REPO_ROOT), []);
  const root = mkdtempSync(join(tmpdir(), 'hub-dg-'));
  for (const a of ARCH) mkdirSync(join(root, a.dir), { recursive: true });
  mkdirSync(join(root, 'src', 'newthing'));
  const bad = check(root);
  assert.ok(bad.some((b) => /src\/newthing is not in the diagram/.test(b)) && bad.some((b) => /arch: docs\/generated\/arch\.txt is out of date/.test(b)));
  check(root, true); writeFileSync(join(root, 'docs', 'generated', 'routing.txt'), 'stale');
  assert.ok(check(root).some((b) => b.startsWith('routing:')));
  rmSync(root, { recursive: true, force: true });
});

test('project and handoff diagrams read the project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-dg-'));
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ project: { slug: 'demo', type: 'web-saas' }, agents: [{ id: 'claude', enabled: true }, { id: 'codex', enabled: false }] }));
  writeFileSync(join(root, 'toolkit.json'), JSON.stringify({ selected: [{ id: 'a' }, { id: 'b' }] }));
  writeFileSync(join(root, 'hub.lock.json'), JSON.stringify({ entries: [{ tokenCost: 100 }, { tokenCost: 250 }] }));
  const p = render(build('project', { root }), 'ascii');
  assert.match(p, /Проект demo/); assert.match(p, /агенты:\s+claude\n/); assert.match(p, /инструменты: 2 \(≈ 350 токенов/); assert.match(p, /этап:\s+1 Идея и контекст/);
  const f = join(root, 'card.md');
  writeFileSync(f, '---\nfrom: {"agent":"codex"}\nreason: limit_reached\nbranch: hub/T1/codex\nhead_sha: abcdef1234567\nfiles_changed: ["a.ts"]\n---\n');
  assert.match(render(build('handoff', { file: f }), 'ascii'), /агент A: \{"agent":"codex"\}[\s\S]*hub\/T1\/codex  head abcdef12/);
});
