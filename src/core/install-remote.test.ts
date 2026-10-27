import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-rem-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const { previewComponent, planLibraryInstall, defaultTextFetcher } = await import('./install-remote.ts');
const { applyPlan, undoBackup } = await import('./plan.ts');
const { scanLocalSkills, library, HUB_HOME } = await import('./registry.ts');
const { auditLoading } = await import('./loading.ts');

const SKILL_MD = '---\nname: webapp-testing\ndescription: Test local web apps with Playwright.\nlicense: MIT\n---\nUse scripts/with_server.py';
const catalog = (extra: object = {}) => JSON.stringify({ components: [
  { id: 'skills/development/webapp-testing', type: 'skills', name: 'webapp-testing', path: 'development/webapp-testing', description: 'Test local web apps', license: 'MIT', files: ['LICENSE.txt', 'scripts/with_server.py'], urls: { content: 'https://www.aitmpl.com/component-content/skills/development/webapp-testing.json' }, scan: { tool: 'skillspector', severity: 'MEDIUM', score: 49 }, ...extra },
  { id: 'skills/x/evil', type: 'skills', name: 'evil', path: 'x/evil', files: ['../../etc/passwd'], urls: { content: 'https://www.aitmpl.com/component-content/skills/x/evil.json' } },
  { id: 'skills/x/risky', type: 'skills', name: 'risky', path: 'x/risky', files: [], urls: { content: 'https://www.aitmpl.com/component-content/skills/x/risky.json' }, scan: { tool: 'skillspector', severity: 'HIGH', score: 90 } },
  { id: 'mcps/audio/elevenlabs', type: 'mcps', name: 'elevenlabs', path: 'audio/elevenlabs.json', description: 'Voices', urls: { content: 'https://www.aitmpl.com/component-content/mcps/audio/elevenlabs.json' } },
] });
const fetcher = async (url: string): Promise<string> => {
  if (url.endsWith('/skills.json')) return catalog();
  if (url.endsWith('/mcps.json')) return catalog();
  if (url.endsWith('webapp-testing.json')) return JSON.stringify({ content: SKILL_MD });
  if (url.endsWith('/evil.json')) return JSON.stringify({ content: '---\nname: evil\ndescription: x\n---\n' });
  if (url.endsWith('/risky.json')) return JSON.stringify({ content: '---\nname: risky\ndescription: x\n---\n' });
  if (url.endsWith('elevenlabs.json')) return JSON.stringify({ content: JSON.stringify({ mcpServers: { elevenlabs: { command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: '<your-api-key>' } } } }) });
  if (url.endsWith('LICENSE.txt')) return 'MIT License';
  if (url.endsWith('with_server.py')) return 'print("hi")';
  throw new Error('unexpected ' + url);
};

test('skill preview lists every file and the catalog scan; plan writes only into the hub library; undo removes it', async () => {
  const p = await previewComponent('aitmpl/skills/development/webapp-testing', fetcher);
  assert.equal(p.blocked, undefined); assert.equal(p.runsCode, true);
  assert.deepEqual(p.files.map((f) => f.path).sort(), ['LICENSE.txt', 'SKILL.md', 'scripts/with_server.py']);
  assert.equal(p.scan?.severity, 'MEDIUM');
  const plan = planLibraryInstall(p);
  assert.ok(plan.changes.every((c) => c.path.startsWith(join(HUB_HOME, 'skills', 'webapp-testing'))), 'only inside the hub library');
  assert.ok(plan.notes.some((n) => /scripts or starts a program/.test(n)));
  assert.ok(!existsSync(join(HUB_HOME, 'skills')), 'dry run wrote nothing');
  const r = applyPlan(plan, { approved: true });
  assert.equal(readFileSync(join(HUB_HOME, 'skills', 'webapp-testing', 'scripts', 'with_server.py'), 'utf8'), 'print("hi")');
  // installed in the library = visible to NO agent, so it adds nothing to anyone's per-turn cost
  const e = scanLocalSkills().find((x) => x.id === 'skill/webapp-testing')!;
  assert.deepEqual(e.visibleTo, []); assert.equal(e.scope, 'hub');
  assert.equal(auditLoading(mkdtempSync(join(tmpdir(), 'hub-p-'))).rows.some((x) => x.name === 'webapp-testing'), false);
  // second install is refused: it exists now
  assert.match((await previewComponent('aitmpl/skills/development/webapp-testing', fetcher)).blocked ?? '', /already exists/);
  undoBackup(HUB_HOME, r.backupId);
  assert.ok(!existsSync(join(HUB_HOME, 'skills', 'webapp-testing', 'SKILL.md')));
});

test('refusals: path traversal in the file list, a HIGH scan rating, ids that are not aitmpl skills/mcps, hosts outside the allow-list', async () => {
  assert.match((await previewComponent('aitmpl/skills/x/evil', fetcher)).blocked ?? '', /unsafe file path/);
  assert.match((await previewComponent('aitmpl/skills/x/risky', fetcher)).blocked ?? '', /rated it HIGH/);
  assert.throws(() => planLibraryInstall({ blocked: 'x' } as never), /x/);
  await assert.rejects(previewComponent('github/o/r', fetcher), /only aitmpl/);
  await assert.rejects(previewComponent('aitmpl/skills/nope/none', fetcher), /not in the catalog/);
  await assert.rejects(defaultTextFetcher('https://evil.example.com/a'), /host not allowed/);
  await assert.rejects(defaultTextFetcher('https://raw.githubusercontent.com/someone-else/repo/main/x'), /host not allowed/);
  await assert.rejects(defaultTextFetcher('http://www.aitmpl.com/x'), /host not allowed/);
});

test('MCP: becomes a library entry with env NAMES only, never values; it is not linked to any project by itself', async () => {
  const p = await previewComponent('aitmpl/mcps/audio/elevenlabs', fetcher);
  assert.equal(p.blocked, undefined); assert.deepEqual(p.mcp, { command: 'uvx', args: ['elevenlabs-mcp'], env: ['ELEVENLABS_API_KEY'] });
  const plan = planLibraryInstall(p);
  assert.ok(plan.notes.some((n) => /ELEVENLABS_API_KEY/.test(n)));
  applyPlan(plan, { approved: true });
  const e = library().find((x) => x.id === 'mcp/elevenlabs')!;
  assert.equal(e.sourceVerified, false); assert.equal(e.risk.executesCode, true);
  const raw = readFileSync(join(HUB_HOME, 'registry', 'mcps-audio-elevenlabs.json'), 'utf8');
  assert.ok(!raw.includes('<your-api-key>'), 'the placeholder value is not stored either');
});

test('makeTextFetcher stops reading at the cap while streaming (a body with no end is not buffered) and honours an outer deadline signal', async () => {
  const { createServer } = await import('node:http');
  const { makeTextFetcher } = await import('./install-remote.ts');
  let sent = 0, closed = false;
  const srv = createServer((req, res) => {
    if (req.url === '/small') { res.end('hello'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });             // no content-length: a chunked body that never ends
    res.on('close', () => { closed = true; });
    const chunk = 'x'.repeat(64 * 1024);
    const pump = (): void => { while (!closed && sent < 5000) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } } if (!closed) res.end(); };
    if (req.url === '/slow') { res.write('a'); return; }                // starts, then stalls
    pump();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const f = makeTextFetcher((u) => u.hostname === '127.0.0.1');
  try {
    assert.equal(await f(`${base}/small`, 100), 'hello');
    await assert.rejects(f(`${base}/endless`, 100_000), /too large/);
    assert.ok(sent < 200, `the reader gave up early (sent ${sent} chunks of 5000)`);
    const t = Date.now();
    await assert.rejects(f(`${base}/slow`, 1000, AbortSignal.timeout(150)));
    assert.ok(Date.now() - t < 5000, 'the outer deadline ended the request, not the 20 s per-request timeout');
    await assert.rejects(f('http://example.com/x', 100), /host not allowed/);
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});
