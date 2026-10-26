import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from the real machine: fake HOME with one skill, own hub home.
const fake = mkdtempSync(join(tmpdir(), 'hub-core-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const sk = (name: string, desc: string, extra = ''): void => {
  const d = join(fake, '.agents', 'skills', name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\nlicense: MIT\n---\n# ${name}\n${extra}\n`);
};
sk('graphify', 'Turn a folder into a knowledge graph for agents.');
sk('ponytail', 'Laziest solution that works, minimal code.');
sk('senior-architect', 'Architecture decisions, diagrams and trade-offs.', 'run scripts/diagram.py');
const { library, scanLocalSkills } = await import('./registry.ts');
const { compileRules, compileSkill, compileMcpClaude, compileMcpCodex } = await import('./compilers.ts');
const { applyPlan, undoBackup, effective, describe } = await import('./plan.ts');
const { planInit } = await import('./init.ts');
const { classifyHooks } = await import('./hooks.ts');
const { scout } = await import('./scout.ts');

const project = (): string => mkdtempSync(join(tmpdir(), 'hub-proj-'));

test('scanLocalSkills reads name, description, token cost, code risk', () => {
  const s = scanLocalSkills();
  const g = s.find((e) => e.id === 'skill/graphify');
  assert.ok(g && g.tokenCost > 0 && g.license === 'MIT');
  assert.equal(s.find((e) => e.id === 'skill/senior-architect')?.risk.executesCode, true);
});

test('compileRules: creates AGENTS.md + pointer, never overwrites, is idempotent', () => {
  const root = project();
  const first = compileRules(root);
  assert.deepEqual(first.map((c) => c.path.split(/[\\/]/).pop()), ['AGENTS.md', 'CLAUDE.md']);
  writeFileSync(join(root, 'AGENTS.md'), 'MY RULES\n'); writeFileSync(join(root, 'CLAUDE.md'), '# mine\n');
  const second = compileRules(root);
  assert.equal(second.length, 1);
  assert.match(second[0]!.after, /# mine[\s\S]*@AGENTS\.md/);
  writeFileSync(join(root, 'CLAUDE.md'), second[0]!.after);
  assert.equal(compileRules(root).length, 0);
});

test('apply + undo returns every file byte-identical and removes created ones', () => {
  const root = project();
  writeFileSync(join(root, 'CLAUDE.md'), '# mine\r\nline\n');
  const before = readFileSync(join(root, 'CLAUDE.md'));
  const lib = library();
  const skills = ['graphify', 'ponytail'].map((n) => lib.find((e) => e.id === `skill/${n}`)!);
  const plan = effective({ root, changes: [...compileRules(root), ...skills.flatMap((s) => compileSkill(root, s))], notes: [] });
  assert.ok(describe(plan).length >= 5);
  assert.throws(() => applyPlan(plan, { approved: false }), /not approved/);
  const r = applyPlan(plan, { approved: true });
  assert.ok(existsSync(join(root, '.claude', 'skills', 'graphify', 'SKILL.md')), 'junction resolves');
  assert.ok(existsSync(join(root, '.agents', 'skills', 'ponytail', 'SKILL.md')));
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  undoBackup(root, r.backupId);
  assert.deepEqual(readFileSync(join(root, 'CLAUDE.md')), before);
  assert.ok(!existsSync(join(root, 'AGENTS.md')) && !existsSync(join(root, '.claude', 'skills', 'graphify')));
  assert.ok(existsSync(join(fake, '.agents', 'skills', 'graphify', 'SKILL.md')), 'undo must not delete the link target');
});

test('applyPlan refuses paths outside the project root', () => {
  const root = project();
  const evil = { root, notes: [], changes: [{ path: join(root, '..', 'escape.txt'), action: 'create' as const, before: null, after: 'x' }] };
  assert.throws(() => applyPlan(evil, { approved: true }), /outside allowed roots/);
});

test('MCP: .mcp.json keeps existing servers, env as references; codex blocks are idempotent', () => {
  const root = project();
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }));
  const e = [{ id: 'mcp/shadcn', kind: 'mcp', mcp: { command: 'npx', args: ['shadcn@latest', 'mcp'], env: ['TOKEN'] } }, { id: 'mcp/mobbin', kind: 'mcp', mcp: { url: 'https://api.mobbin.com/mcp' } }] as any[];
  const c = compileMcpClaude(root, e)[0]!;
  const j = JSON.parse(c.after);
  assert.deepEqual(Object.keys(j.mcpServers).sort(), ['mine', 'mobbin', 'shadcn']);
  assert.equal(j.mcpServers.shadcn.env.TOKEN, '${TOKEN}');
  assert.equal(j.other, 1);
  const cx = compileMcpCodex(root, e)[0]!;
  mkdirSync(join(root, '.codex'), { recursive: true }); writeFileSync(join(root, '.codex', 'config.toml'), `model = "x"\n\n${cx.after}`);
  assert.equal(compileMcpCodex(root, e)[0]!.after, readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), 'second compile changes nothing');
  assert.match(cx.after, /\[mcp_servers\.shadcn\][\s\S]*args = \["shadcn@latest", "mcp"\]/);
  writeFileSync(join(root, '.mcp.json'), '{broken');
  assert.throws(() => compileMcpClaude(root, e), /not valid JSON/);
});

test('classifyHooks: native / adapted / unknown / unsupported, never assumes', () => {
  const j = JSON.stringify({ hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/run.cmd" start' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'check.sh' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'prompt', command: '' }] }],
  } });
  const r = classifyHooks(j, 'C:\\plug');
  const by = (ev: string) => r.find((x) => x.event === ev)!;
  assert.equal(by('SessionStart').codex, 'adapted');
  assert.match(by('SessionStart').codexCommand!, /^"C:\/plug\/run\.cmd" start$/);
  assert.equal(by('Stop').codex, 'native');
  assert.equal(by('PreToolUse').codex, 'unknown');
  assert.equal(by('UserPromptSubmit').codex, 'unsupported');
});

test('planInit is a dry run: lists files, writes nothing, reports missing library items', () => {
  const root = project();
  const p = planInit(root, { type: 'web-saas' });
  assert.deepEqual(readdirSync(root), []);
  const names = p.changes.map((c) => c.path.replace(root, '').replace(/\\/g, '/'));
  for (const f of ['/hub.json', '/toolkit.json', '/hub.lock.json', '/AGENTS.md', '/CLAUDE.md', '/.claude/skills/graphify', '/.agents/skills/ponytail']) assert.ok(names.includes(f), f);
  assert.ok(p.missing.includes('skill/product-ui-workbench'));
  const lock = JSON.parse(p.changes.find((c) => c.path.endsWith('hub.lock.json'))!.after);
  assert.ok(lock.entries.every((e: any) => e.hash === null || /^[0-9a-f]{64}$/.test(e.hash)));
  const r = applyPlan(p, { approved: true });
  assert.ok(r.written.length >= 8 && lstatSync(join(root, 'hub.json')).isFile());
  assert.equal(planInit(root, { type: 'web-saas' }).changes.length, 1, 'second init only rewrites the lock timestamp-free diff');
});

test('scout ranks by brief/type, penalizes token cost and risk, skips installed, max 5', () => {
  const lib = library();
  const base = (id: string, over: object) => ({ id, kind: 'skill', title: id, description: '', source: { type: 'local' }, tags: [], stages: [], projectTypes: ['*'], compat: { claude: 'native', codex: 'native' }, tokenCost: 100, risk: { executesCode: false, network: false, writesOutside: false }, sourceVerified: true, license: 'MIT', ...over }) as any;
  const cand = [base('skill/ui', { description: 'react components dashboard', tags: ['ui'], projectTypes: ['web-saas'] }), base('skill/heavy', { description: 'react components dashboard', tags: ['ui'], projectTypes: ['web-saas'], tokenCost: 2000, risk: { executesCode: true, network: true, writesOutside: false } }), base('skill/none', { description: 'cooking recipes' })];
  const r = scout([...cand, ...lib], { brief: 'react dashboard with components', projectType: 'web-saas', installed: ['skill/graphify'], limit: 5 });
  assert.equal(r[0]!.entry.id, 'skill/ui');
  assert.ok(r.findIndex((c) => c.entry.id === 'skill/ui') < r.findIndex((c) => c.entry.id === 'skill/heavy'));
  assert.ok(!r.some((c) => c.entry.id === 'skill/graphify') && r.length <= 5);
});

test('rules: every project type gets the shared rules plus its own section, no template placeholders left', async () => {
  const { renderRules } = await import('./compilers.ts');
  const expected: Record<string, RegExp> = { 'web-saas': /Rules for a web product/, 'mobile-app': /Rules for a mobile app/, automation: /Rules for automations, bots and agents/, 'design-study': /Rules for a design study/ };
  for (const [type, re] of Object.entries(expected)) {
    const t = renderRules('demo', type);
    assert.match(t, re); assert.match(t, /## Hard rules/); assert.match(t, /Project: demo/); assert.ok(!t.includes('{{'), type);
    for (const other of Object.values(expected)) if (other !== re) assert.doesNotMatch(t, other, 'sections of other types do not leak in');
  }
  const generic = renderRules('demo');
  assert.match(generic, /## How to work, by kind of task/); assert.ok(!/Rules for a/.test(generic) && !generic.includes('{{'));
  assert.ok(renderRules('x', 'web-saas').split('\n').length < 90, 'stays short: it is loaded on every turn');
});

test('init says plainly which skills are missing or not installed, in Russian, with the install command when known', async () => {
  const { planInit } = await import('./init.ts');
  const root = mkdtempSync(join(tmpdir(), 'hub-notes-'));
  const plan = planInit(root, { type: 'web-saas' });
  assert.ok(plan.notes.some((n) => /Скилл «product-ui-workbench» не найден/.test(n) && /Свои папки со скиллами/.test(n)), plan.notes.join(' | '));
});
