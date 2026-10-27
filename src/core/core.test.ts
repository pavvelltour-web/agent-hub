import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from the real machine: fake HOME with one skill, own hub home.
const fake = mkdtempSync(join(tmpdir(), 'hub-core-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
process.env['HUB_GRAPHIFY'] = 'off';   // graph features are tested on their own; these tests must not depend on whether this PC has graphify
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

test('rules: token-saving context rules and the Autopilot lessons are in, and the text stays short and free of filler', async () => {
  const { renderRules } = await import('./compilers.ts');
  const { REPO_ROOT } = await import('./registry.ts');
  const keyPhrases = ['removed only by the user', 'verbatim and nothing else', '2 repairs', 'Cause first', 'placeholders', 'pointers, not a retelling'];
  const exact = [
    'Ask the graph first: `graphify query "<question>" --budget 800`. Open only the files and line ranges it names. Never list or read the whole repository.',
    'Read a file in slices (`offset`/`limit`); re-read only what changed.',
    'Run the tests once after the last edit, and again only after a change or a failure. Stop when the acceptance test passes.',
    'Keep only non-standard conventions here; never describe the repository layout (the graph does that).',
  ];
  for (const type of [undefined, 'web-saas', 'mobile-app', 'automation', 'design-study']) {
    const t = renderRules('demo', type);
    for (const s of exact) assert.ok(t.includes(s), `${type}: missing rule: ${s.slice(0, 40)}`);
    for (const k of keyPhrases) assert.ok(t.includes(k), `${type}: missing key phrase "${k}"`);
    assert.ok(t.trimEnd().split('\n').length <= 70, `${type}: ${t.trimEnd().split('\n').length} lines, max 70`);
    assert.doesNotMatch(t, /^#+ .*(overview|layout|structure|repository map|project map)/im, `${type}: no repository overview section`);
    assert.doesNotMatch(t, /be thorough|think deeply|make sure 100\s*%/i, `${type}: no filler that burns tokens`);
  }
  // The hub's own AGENTS.md follows the same rules (it is loaded on every turn of every agent working on this repo).
  const own = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  for (const k of keyPhrases) assert.ok(own.includes(k), `AGENTS.md: missing key phrase "${k}"`);
  assert.doesNotMatch(own, /^#+ .*(repository map|overview)/im, 'AGENTS.md: the graph is the map, not a section here');
  assert.doesNotMatch(own, /be thorough|think deeply|make sure 100\s*%/i);
});

test('init says plainly which skills are missing or not installed, in Russian, with the install command when known', async () => {
  const { planInit } = await import('./init.ts');
  const root = mkdtempSync(join(tmpdir(), 'hub-notes-'));
  const plan = planInit(root, { type: 'web-saas' });
  assert.ok(plan.notes.some((n) => /Скилл «product-ui-workbench» не найден/.test(n) && /Свои папки со скиллами/.test(n)), plan.notes.join(' | '));
});

// ── graph as a first-class project tool (ADR-021) ─────────────────────────────────────────────────────────────────────────────────────────
const { graphStatus, locateGraphify, updateGraph, GRAPHIGNORE } = await import('./graph.ts');
const { utimesSync, existsSync: exists2, rmSync } = await import('node:fs');
const { git: gitRun } = await import('../run/git.ts');
const gtmp: string[] = [];
const fakeGraph = (mode: 'ok' | 'fail' | 'hang'): { tool: { cmd: string; prefix: string[] }; log: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-fakegraph-')); gtmp.push(dir);
  const log = join(dir, 'calls.jsonl'), script = join(dir, 'g.mjs');
  writeFileSync(script, `import { mkdirSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';\nimport { join } from 'node:path';\nconst a = process.argv.slice(2);\n` +
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cwd: process.cwd(), cwdEmpty: readdirSync(process.cwd()).length === 0, env: Object.keys(process.env) }) + '\\n');\n` +
    (mode === 'hang' ? `setTimeout(() => {}, 60000);\n` : mode === 'fail' ? `console.error('boom: token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected'); console.error('graphify: cannot parse x.py'); process.exit(3);\n`
      : `if (a[0] !== 'update') process.exit(2);\nmkdirSync(join(a[1], 'graphify-out'), { recursive: true });\nwriteFileSync(join(a[1], 'graphify-out', 'graph.json'), '{"nodes":[]}');\nconsole.log('Code graph updated.');\n`));
  return { tool: { cmd: process.execPath, prefix: [script] }, log };
};
const calls = (log: string): { argv: string[]; cwd: string; cwdEmpty: boolean; env: string[] }[] => (exists2(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const buildGraph = (root: string, age = 0): string => { const g = join(root, 'graphify-out', 'graph.json'); mkdirSync(join(root, 'graphify-out'), { recursive: true }); writeFileSync(g, '{}'); const t = new Date(Date.now() - age); utimesSync(g, t, t); return g; };
const touch = (p: string, msAgo: number): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); const t = new Date(Date.now() - msAgo); utimesSync(p, t, t); };
const audits = (root: string): { action: string; ok: boolean }[] => readFileSync(join(root, '.hub', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('init plan offers the graph when graphify is available: a .graphifyignore that keeps secrets and build output out, and a note; nothing when it is not', () => {
  const root = project(); writeFileSync(join(root, 'a.py'), 'x = 1\n');
  const tool = { cmd: process.execPath, prefix: [] as string[] };
  const withG = planInit(root, { type: 'web-saas', graphify: tool });
  const ign = withG.changes.find((c) => c.path === join(root, '.graphifyignore'));
  assert.ok(ign && ign.action === 'create', '.graphifyignore is part of the plan');
  for (const line of ['node_modules/', '.env', 'secrets/', 'auth.json', '.credentials.json', 'dist/']) assert.ok(ign!.after.split('\n').includes(line), line);
  assert.equal(ign!.after, GRAPHIGNORE);
  assert.ok(withG.notes.some((n) => /граф проекта/i.test(n) && /Построить граф проекта/.test(n)), withG.notes.join(' | '));
  assert.ok(!exists2(join(root, '.graphifyignore')), 'planning writes nothing');

  const without = planInit(root, { type: 'web-saas', graphify: null });
  assert.ok(!without.changes.some((c) => c.path.endsWith('.graphifyignore')) && !without.notes.some((n) => /граф проекта/i.test(n)));

  writeFileSync(join(root, '.graphifyignore'), 'my-own/\n');
  assert.ok(!planInit(root, { type: 'web-saas', graphify: tool }).changes.some((c) => c.path.endsWith('.graphifyignore')), 'the user\'s own file is never replaced');
  touch(join(root, 'a.py'), 60_000); buildGraph(root, 0);
  assert.ok(!planInit(root, { type: 'web-saas', graphify: tool }).notes.some((n) => /граф проекта/i.test(n)), 'a built graph is not offered again');
  buildGraph(root, 60_000); touch(join(root, 'a.py'), 1000);
  assert.ok(planInit(root, { type: 'web-saas', graphify: tool }).notes.some((n) => /устарел/.test(n)), 'a stale graph is offered for refresh');
});

test('graph status: missing → built → stale when a project file is newer than graphify-out/graph.json; ignored and generated files do not count', () => {
  const root = project();
  assert.equal(graphStatus(root).state, 'missing');
  touch(join(root, 'src', 'a.ts'), 120_000); touch(join(root, 'README.md'), 120_000);
  buildGraph(root, 60_000);
  const built = graphStatus(root);
  assert.equal(built.state, 'built'); assert.equal(built.staleFiles, 0); assert.ok(built.builtAt && Number.isFinite(Date.parse(built.builtAt)));
  // changes that must not make the graph stale
  touch(join(root, 'node_modules', 'x', 'i.js'), 1000); touch(join(root, '.git', 'HEAD'), 1000); touch(join(root, '.hub', 'audit.jsonl'), 1000); touch(join(root, 'graphify-out', 'GRAPH_REPORT.md'), 1000);
  touch(join(root, '.graphifyignore'), 100_000); writeFileSync(join(root, '.graphifyignore'), '# comment\ndist/\n*.log\ndocs/generated/\n/tmp-root.txt\ntsconfig*.json\n'); utimesSync(join(root, '.graphifyignore'), new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  for (const f of ['dist/b.js', 'x/y/app.log', 'docs/generated/d.md', 'tmp-root.txt', 'tsconfig.build.json']) touch(join(root, f), 1000);
  assert.equal(graphStatus(root).state, 'built', 'ignored paths are not tracked files');
  touch(join(root, 'sub', 'tmp-root.txt'), 1000);   // `/name` is anchored at the root: a same-named file deeper down still counts
  const s1 = graphStatus(root);
  assert.equal(s1.state, 'stale'); assert.equal(s1.staleFiles, 1); assert.equal(s1.example, 'sub/tmp-root.txt');
  touch(join(root, 'src', 'a.ts'), 500);
  const s2 = graphStatus(root);
  assert.equal(s2.state, 'stale'); assert.equal(s2.staleFiles, 2); assert.equal(s2.example, 'src/a.ts', 'the newest change is the example');
  buildGraph(root, 0);
  assert.equal(graphStatus(root).state, 'built', 'rebuilding the graph clears it');
  rmSync(join(root, 'graphify-out', 'graph.json')); mkdirSync(join(root, 'graphify-out', 'graph.json'));
  assert.equal(graphStatus(root).state, 'missing', 'a folder named graph.json is not a graph');
});

test('graph status in a git repo: untracked-but-ignored files (.gitignore) do not make it stale', () => {
  const root = project();
  gitRun(root, ['init', '-q', '-b', 'main']); touch(join(root, '.gitignore'), 120_000); writeFileSync(join(root, '.gitignore'), 'build/\n'); utimesSync(join(root, '.gitignore'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000)); touch(join(root, 'a.ts'), 120_000);
  buildGraph(root, 60_000);
  touch(join(root, 'build', 'out.js'), 1000);
  assert.equal(graphStatus(root).state, 'built');
  touch(join(root, 'new.ts'), 1000);
  assert.equal(graphStatus(root).state, 'stale', 'a new, not yet committed file counts');
});

test('locateGraphify: HUB_GRAPHIFY=off disables it; an empty PATH finds nothing; a relative PATH entry is never searched', () => {
  assert.equal(locateGraphify({ HUB_GRAPHIFY: 'off', PATH: process.env['PATH'] }), undefined);
  assert.equal(locateGraphify({ PATH: '' }), undefined);
  const planted = project(); writeFileSync(join(planted, process.platform === 'win32' ? 'graphify.exe' : 'graphify'), 'not a program');
  assert.equal(locateGraphify({ PATH: '.' }), undefined);
  assert.equal(locateGraphify({ PATH: planted }), undefined, 'a file that is not a working graphify is not accepted');
});

test('graph update: argv array, own empty throw-away cwd, allowlisted env without API keys, written to the audit log; the graph is then built', async () => {
  const root = project(); const home = mkdtempSync(join(tmpdir(), 'hub-gh-')); const f = fakeGraph('ok');
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-not-reach-graphify'; process.env['GEMINI_API_KEY'] = 'g-should-not-reach'; process.env['HUB_SESSION_TOKEN'] = 'hubtok';
  try {
    touch(join(root, 'ü пробел', 'm.py'), 1000);
    const r = updateGraph(root, { tool: f.tool, home });
    assert.equal(r.started, true);
    assert.equal(graphStatus(root).state, 'missing');
    const last = await r.done;
    assert.equal(last.ok, true); assert.match(last.message, /Code graph updated/);
    const c = calls(f.log); assert.equal(c.length, 1);
    assert.deepEqual(c[0]!.argv, ['update', root]);
    assert.notEqual(c[0]!.cwd.toLowerCase(), root.toLowerCase()); assert.equal(c[0]!.cwdEmpty, true, 'the tool did not run in the project folder');
    assert.ok(!exists2(c[0]!.cwd), 'the throw-away cwd is removed afterwards');
    const names = c[0]!.env.map((k) => k.toUpperCase());
    assert.ok(names.includes('PATH'), 'PATH kept');
    for (const bad of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HUB_SESSION_TOKEN']) assert.ok(!names.includes(bad), `${bad} must not reach graphify`);
    assert.equal(graphStatus(root).state, 'built');
    assert.equal(audits(root).at(-1)!.action, 'graph-update'); assert.equal(audits(root).at(-1)!.ok, true);
    assert.equal(graphStatus(root).running, false);
    assert.equal(graphStatus(root).last?.ok, true);
  } finally { delete process.env['ANTHROPIC_API_KEY']; delete process.env['GEMINI_API_KEY']; delete process.env['HUB_SESSION_TOKEN']; rmSync(home, { recursive: true, force: true }); }
});

test('graph update: one at a time per project; a failing tool is reported with its last line, secrets redacted; a hung tool is killed at the timeout', async () => {
  const root = project(); const home = mkdtempSync(join(tmpdir(), 'hub-gh-'));
  try {
    const slow = fakeGraph('hang');
    const a = updateGraph(root, { tool: slow.tool, home, timeoutMs: 1500 });
    assert.equal(a.started, true); assert.equal(graphStatus(root).running, true);
    const b = updateGraph(root, { tool: slow.tool, home });
    assert.equal(b.started, false); assert.match(b.reason ?? '', /already running/);
    const killed = await a.done;
    assert.equal(killed.ok, false); assert.match(killed.message, /timed out/);
    assert.equal(graphStatus(root).running, false);

    const bad = fakeGraph('fail');
    const r = await updateGraph(root, { tool: bad.tool, home }).done;
    assert.equal(r.ok, false); assert.match(r.message, /cannot parse x\.py/);
    assert.ok(!/sk-ant-api03-ABCDEFGHIJ/.test(JSON.stringify(graphStatus(root))) && !/sk-ant-api03-ABCDEFGHIJ/.test(r.message), 'secrets are redacted before they are kept');
    assert.deepEqual(audits(root).map((x) => x.ok), [false, false]);
    assert.equal(graphStatus(root).state, 'missing', 'a failed update leaves no graph behind');

    assert.equal(updateGraph(join(root, 'missing-dir'), { tool: bad.tool, home }).started, false, 'not a folder');
    assert.equal(updateGraph('relative/path', { tool: bad.tool, home }).started, false, 'not absolute');
    const gone = updateGraph(root, { tool: { cmd: join(root, 'no-such-tool.exe'), prefix: [] }, home });
    assert.equal(gone.started, true); assert.equal((await gone.done).ok, false, 'a tool that cannot start is a failure, not a crash');
  } finally { rmSync(home, { recursive: true, force: true }); for (const d of gtmp) rmSync(d, { recursive: true, force: true }); }
});
