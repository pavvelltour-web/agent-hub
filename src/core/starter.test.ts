import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-starter-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const { loadStarter, starterItems, previewStarter, planStarter, starterFetcher } = await import('./starter.ts');
const { applyPlan, undoBackup } = await import('./plan.ts');
const { HUB_HOME } = await import('./registry.ts');
process.on('exit', () => { try { rmSync(fake, { recursive: true, force: true }); } catch { /* best effort */ } });

const SHA = 'a'.repeat(40);
const md = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill.\n---\nBody of ${name}`;
type Node = { path: string; mode?: string; type?: string; size?: number };
/** A fake GitHub: ref → sha, tree, raw files. `files` = repo-relative path → text. */
const github = (files: Record<string, string>, o: { tree?: Node[]; truncated?: boolean; sha?: string; calls?: string[] } = {}) => async (url: string): Promise<string> => {
  o.calls?.push(url);
  if (/\/git\/ref\/heads\//.test(url)) return JSON.stringify({ object: { sha: o.sha ?? SHA } });
  if (/\/git\/trees\//.test(url)) return JSON.stringify({ truncated: o.truncated ?? false, tree: o.tree ?? Object.entries(files).map(([path, t]) => ({ path, mode: '100644', type: 'blob', size: t.length })) });
  const m = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/[0-9a-f]{40}\/(.+)$/.exec(url);
  if (m && files[m[1]!] !== undefined) return files[m[1]!]!;
  throw new Error('unexpected ' + url);
};
const entry = (id: string, license = 'MIT', extra: object = {}) => ({ id, license, why: 'why ' + id, source: { type: 'github' as const, repo: 'o/r', path: `skills/${id}`, ref: 'main', ...extra } });

test('shipped starter list: seven skills, each with license and a target under the hub library; unknown license and manual sources are unchecked', () => {
  const items = starterItems();
  assert.deepEqual(items.map((i) => i.id), ['graphify', 'test-driven-development', 'systematic-debugging', 'verification-before-completion', 'grill-me', 'autopilot', 'senior-architect']);
  for (const i of items) { assert.ok(i.license, i.id); assert.ok(i.why.length > 5, i.id); assert.equal(i.target, join(HUB_HOME, 'skills', i.id)); }
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['test-driven-development']!.checked, true, 'known license + fetchable source: on by default');
  assert.equal(by['grill-me']!.license, 'unknown'); assert.equal(by['grill-me']!.checked, false, 'unknown license: off by default');
  assert.equal(by['graphify']!.checked, false, 'a source the hub cannot fetch is never on by default'); assert.equal(by['graphify']!.state, 'manual');
  assert.match(by['graphify']!.installCommand ?? '', /graphifyy/);
  assert.ok(!existsSync(join(fake, '.claude')) && !existsSync(join(fake, '.agents')), 'listing wrote nothing');
});

test('plan lists every file under HUB_HOME/skills with license and commit; nothing is written to ~/.claude or ~/.agents; undo removes it', async () => {
  const files = { 'skills/alpha/SKILL.md': md('alpha'), 'skills/alpha/scripts/run.py': 'print(1)', 'skills/beta/SKILL.md': md('beta'), 'skills/other/SKILL.md': md('other') };
  const pv = await previewStarter(['alpha', 'beta'], github(files), [entry('alpha'), entry('beta'), entry('other')]);
  assert.deepEqual(pv.skipped, []); assert.deepEqual(pv.items.map((i) => i.id), ['alpha', 'beta']);
  const alpha = pv.items[0]!;
  assert.equal(alpha.license, 'MIT'); assert.equal(alpha.commit, SHA); assert.equal(alpha.target, join(HUB_HOME, 'skills', 'alpha')); assert.equal(alpha.runsCode, true);
  assert.deepEqual(alpha.files.map((f) => f.path).sort(), ['.hub-source.json', 'SKILL.md', 'scripts/run.py']);
  const plan = planStarter(pv);
  assert.ok(plan.changes.every((c) => c.path.startsWith(join(HUB_HOME, 'skills') + '\\') || c.path.startsWith(join(HUB_HOME, 'skills') + '/')), 'only inside the hub library');
  assert.ok(plan.notes.some((n) => /alpha/.test(n) && /scripts or starts a program/.test(n)));
  assert.ok(plan.notes.some((n) => n.includes(SHA.slice(0, 7))), 'the pinned commit is shown');
  assert.ok(!existsSync(join(HUB_HOME, 'skills')), 'dry run wrote nothing');
  const src = JSON.parse(plan.changes.find((c) => c.path.endsWith('.hub-source.json') && c.path.includes('alpha'))!.after) as Record<string, string>;
  assert.deepEqual(src, { id: 'alpha', repo: 'o/r', path: 'skills/alpha', commit: SHA, license: 'MIT' });
  const r = applyPlan(plan, { approved: true });
  assert.equal(readFileSync(join(HUB_HOME, 'skills', 'alpha', 'scripts', 'run.py'), 'utf8'), 'print(1)');
  assert.ok(!existsSync(join(HUB_HOME, 'skills', 'other')));
  assert.ok(!existsSync(join(fake, '.claude')) && !existsSync(join(fake, '.agents')), 'nothing in the agents\' own folders');
  // a second preview: both exist now, nothing is offered again (never overwritten)
  const again = await previewStarter(['alpha'], github(files), [entry('alpha')]);
  assert.equal(again.items.length, 0); assert.match(again.skipped[0]!.reason, /уже есть/);
  undoBackup(HUB_HOME, r.backupId);
  assert.ok(!existsSync(join(HUB_HOME, 'skills', 'alpha', 'SKILL.md')));
});

test('everything is fetched at one commit: a branch is resolved to a sha, raw files use the sha, the digest covers sha and bytes', async () => {
  const calls: string[] = [];
  const files = { 'skills/alpha/SKILL.md': md('alpha') };
  const a = await previewStarter(['alpha'], github(files, { calls }), [entry('alpha')]);
  assert.ok(calls.some((u) => u.endsWith('/repos/o/r/git/ref/heads/main')));
  assert.ok(calls.some((u) => u.endsWith(`/git/trees/${SHA}?recursive=1`)));
  assert.ok(calls.filter((u) => u.includes('raw.githubusercontent.com')).every((u) => u.includes(`/o/r/${SHA}/`)), 'raw urls carry the commit, never a branch');
  const b = await previewStarter(['alpha'], github({ 'skills/alpha/SKILL.md': md('alpha') + ' changed' }), [entry('alpha')]);
  const c = await previewStarter(['alpha'], github(files, { sha: 'b'.repeat(40) }), [entry('alpha')]);
  assert.notEqual(a.digest, b.digest, 'changed bytes: new digest'); assert.notEqual(a.digest, c.digest, 'moved branch: new digest');
  assert.equal(a.digest, (await previewStarter(['alpha'], github(files), [entry('alpha')])).digest, 'same input: same digest');
  // an already pinned ref is used as is: no ref lookup
  const calls2: string[] = [];
  await previewStarter(['alpha'], github(files, { calls: calls2 }), [entry('alpha', 'MIT', { ref: SHA })]);
  assert.ok(!calls2.some((u) => /git\/ref\//.test(u)));
});

test('refusals: symlink, submodule, truncated tree, unsafe path, binary, too large, too many files, name mismatch, no SKILL.md, bad sha, existing folder, symlinked library folder', async () => {
  const ok = { 'skills/alpha/SKILL.md': md('alpha') };
  const why = async (files: Record<string, string>, o: Parameters<typeof github>[1] = {}, e = entry('alpha')): Promise<string> => {
    const p = await previewStarter(['alpha'], github(files, o), [e]); assert.equal(p.items.length, 0, 'nothing installable'); return p.skipped[0]!.reason;
  };
  assert.match(await why(ok, { tree: [{ path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', size: 5 }, { path: 'skills/alpha/link', mode: '120000', type: 'blob', size: 3 }] }), /symlink/i);
  assert.match(await why(ok, { tree: [{ path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', size: 5 }, { path: 'skills/alpha/sub', mode: '160000', type: 'commit' }] }), /submodule/i);
  assert.match(await why(ok, { truncated: true }), /truncated|слишком/i);
  assert.match(await why({ ...ok, 'skills/alpha/a b.md': 'x' }), /unsafe file path/);
  assert.match(await why({ ...ok, 'skills/alpha/NUL.txt': 'x' }), /unsafe file path/);
  assert.match(await why({ ...ok, 'skills/alpha/skill.md': 'x' }), /unsafe file path/, 'two names equal but for case');
  assert.match(await why({ ...ok, 'skills/alpha/.HUB-source.json': 'x' }), /unsafe file path/, 'cannot shadow the provenance file');
  assert.match(await why({ ...ok, 'skills/alpha/x.bin': 'a\u0000b' }), /binary/i);
  assert.match(await why({ ...ok, 'skills/alpha/big.md': 'x'.repeat(300_000) }), /too large/i);
  assert.match(await why(Object.fromEntries([['skills/alpha/SKILL.md', md('alpha')], ...Array.from({ length: 45 }, (_, i) => [`skills/alpha/f${i}.md`, 'x'])])), /too many/i);
  assert.match(await why({ 'skills/alpha/SKILL.md': md('other') }), /name/i);
  assert.match(await why({ 'skills/alpha/readme.md': 'x' }), /SKILL\.md/);
  assert.match(await why(ok, { sha: 'refs/heads/main' }), /commit/i);
  assert.match(await why(ok, {}, entry('alpha', 'MIT', { path: '../x' })), /path/i);
  // a folder with files in the library: skipped, never merged into
  mkdirSync(join(HUB_HOME, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(HUB_HOME, 'skills', 'alpha', 'mine.md'), 'my own notes');
  assert.match(await why(ok), /уже есть/);
  rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true });
  // the library folder itself is a link to elsewhere: refused (a write would leave the hub library)
  const elsewhere = mkdtempSync(join(tmpdir(), 'hub-else-'));
  try {
    mkdirSync(HUB_HOME, { recursive: true });
    let linked = true; try { symlinkSync(elsewhere, join(HUB_HOME, 'skills'), 'junction'); } catch { linked = false; }
    if (linked) assert.match(await why(ok), /link|ссылк/i);
  } finally { rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('sources the hub cannot fetch are skipped with the reason; unknown license is installable only when asked for, with a warning; ids outside the list are refused', async () => {
  const man = { id: 'manual-one', license: 'MIT', why: 'x', source: { type: 'manual' as const, note: 'by hand', installCommand: 'uv tool install x' } };
  const files = { 'skills/alpha/SKILL.md': md('alpha') };
  const p = await previewStarter(['manual-one', 'alpha'], github(files), [man, entry('alpha', 'unknown')]);
  assert.match(p.skipped.find((s) => s.id === 'manual-one')!.reason, /uv tool install x/);
  assert.equal(p.items[0]!.licenseKnown, false);
  assert.ok(planStarter(p).notes.some((n) => /alpha/.test(n) && /лицензи/i.test(n)));
  await assert.rejects(previewStarter(['nope'], github(files), [entry('alpha')]), /not in the starter set/);
  await assert.rejects(previewStarter([], github(files), [entry('alpha')]), /nothing selected/);
  assert.throws(() => planStarter({ items: [], skipped: [], digest: 'x' }), /nothing to install/);
});

test('starter.json is data: bad ids, repos, paths, refs like latest/HEAD and unknown source types are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sj-')); const f = join(dir, 'starter.json');
  const load = (skills: unknown): unknown => { writeFileSync(f, JSON.stringify({ skills })); return loadStarter(f); };
  try {
    const good = entry('alpha');
    assert.doesNotThrow(() => load([good]));
    assert.throws(() => load([{ ...good, id: '../x' }]), /id/);
    assert.throws(() => load([{ ...good, source: { ...good.source, ref: 'latest' } }]), /ref/);
    assert.throws(() => load([{ ...good, source: { ...good.source, ref: 'HEAD' } }]), /ref/);
    assert.throws(() => load([{ ...good, source: { ...good.source, repo: 'https://evil.example/x' } }]), /repo/);
    assert.throws(() => load([{ ...good, source: { ...good.source, path: '../../etc' } }]), /path/);
    assert.throws(() => load([{ ...good, source: { type: 'url', url: 'http://x' } }]), /source/);
    assert.throws(() => load([good, good]), /duplicate/);
    assert.throws(() => load([{ ...good, license: '' }]), /license/);
    writeFileSync(f, '{ not json'); assert.throws(() => loadStarter(f));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real fetcher only talks to the starter repos: other hosts, other repos, http, a branch in a raw url, ports and credentials are refused before any request', async () => {
  const f = starterFetcher([entry('alpha')]);
  const no = (u: string): Promise<void> => assert.rejects(f(u), /host not allowed/, u);
  await no('https://evil.example.com/o/r/' + SHA + '/x');
  await no('https://raw.githubusercontent.com/someone/else/' + SHA + '/x');
  await no('https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md');
  await no('http://raw.githubusercontent.com/o/r/' + SHA + '/x');
  await no('https://api.github.com/repos/someone/else/git/trees/' + SHA);
  await no('https://api.github.com/repos/o/r/contents/skills');
  await no('https://api.github.com/repos/o/r/git/trees/main');
  await no('https://api.github.com:8443/repos/o/r/git/trees/' + SHA);
  await no('https://user:pw@api.github.com/repos/o/r/git/trees/' + SHA);
  await no('https://raw.githubusercontent.com/o/r/' + SHA + '/../../x/y');
});
