import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-starter-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const { loadStarter, starterItems, previewStarter, planStarter, applyStarter, undoStarter, starterFetcher } = await import('./starter.ts');
const { applyPlan } = await import('./plan.ts');
const { HUB_HOME } = await import('./registry.ts');
process.on('exit', () => { try { rmSync(fake, { recursive: true, force: true }); } catch { /* best effort */ } });

const SHA = 'a'.repeat(40);
const md = (name: string, fm = ''): string => `---\nname: ${name}\ndescription: ${name} skill.\n${fm}---\nBody of ${name}`;
type Node = { path: string; mode?: string; type?: string; size?: number };
/** A fake GitHub: a tree at a sha and raw files at that sha. `files` = repo-relative path → text. */
const github = (files: Record<string, string>, o: { tree?: Node[]; truncated?: boolean; calls?: string[]; modes?: Record<string, string>; delay?: number } = {}) => async (url: string): Promise<string> => {
  o.calls?.push(url);
  if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
  if (/\/git\/trees\//.test(url)) return JSON.stringify({ truncated: o.truncated ?? false, tree: o.tree ?? Object.entries(files).map(([path, t]) => ({ path, mode: o.modes?.[path] ?? '100644', type: 'blob', size: t.length })) });
  const m = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/[0-9a-f]{40}\/(.+)$/.exec(url);
  if (m && files[m[1]!] !== undefined) return files[m[1]!]!;
  throw new Error('unexpected ' + url);
};
const entry = (id: string, license = 'MIT', extra: object = {}) => ({ id, license, why: 'why ' + id, source: { type: 'github' as const, repo: 'o/r', path: `skills/${id}`, ref: SHA, ...extra } });
const one = async (files: Record<string, string>, o: Parameters<typeof github>[1] = {}, e = entry('alpha')) => previewStarter(['alpha'], github(files, o), [e]);
const why = async (files: Record<string, string>, o: Parameters<typeof github>[1] = {}, e = entry('alpha')): Promise<string> => {
  const p = await one(files, o, e); assert.equal(p.items.length, 0, 'nothing installable'); return p.skipped[0]!.reason;
};
const ok = { 'skills/alpha/SKILL.md': md('alpha') };

test('shipped starter list: seven skills with license and target under the hub library; every fetchable one is pinned to a 40-hex commit; unknown license and non-fetchable sources are unchecked', () => {
  const items = starterItems();
  assert.deepEqual(items.map((i) => i.id), ['graphify', 'test-driven-development', 'systematic-debugging', 'verification-before-completion', 'grill-me', 'autopilot', 'senior-architect']);
  for (const i of items) { assert.ok(i.license, i.id); assert.ok(i.why.length > 5, i.id); assert.equal(i.target, join(HUB_HOME, 'skills', i.id)); }
  for (const e of loadStarter()) if (e.source.type === 'github') assert.match(e.source.ref, /^[0-9a-f]{40}$/, `${e.id}: pinned`);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['test-driven-development']!.state, 'available'); assert.equal(by['test-driven-development']!.checked, true);
  assert.equal(by['grill-me']!.license, 'unknown'); assert.equal(by['grill-me']!.checked, false, 'unknown license: off by default');
  assert.equal(by['graphify']!.checked, false); assert.equal(by['graphify']!.state, 'manual');
  assert.match(by['graphify']!.installCommand ?? '', /graphifyy/);
  assert.ok(!existsSync(join(fake, '.claude')) && !existsSync(join(fake, '.agents')), 'listing wrote nothing');
});

test('plan: every file in FULL under HUB_HOME/skills with license (as claimed by the list) and commit; apply writes exactly the previewed bytes; nothing in ~/.claude or ~/.agents; undo removes the skill folder', async () => {
  const big = 'line of the skill\n'.repeat(600);                       // ~10 KB: more than any dialog shows by default
  const files = { 'skills/alpha/SKILL.md': md('alpha') + big, 'skills/alpha/notes.md': 'notes', 'skills/beta/SKILL.md': md('beta'), 'skills/other/SKILL.md': md('other') };
  const pv = await previewStarter(['alpha', 'beta'], github(files), [entry('alpha'), entry('beta'), entry('other')]);
  assert.deepEqual(pv.skipped, []); assert.deepEqual(pv.items.map((i) => i.id), ['alpha', 'beta']);
  const alpha = pv.items[0]!;
  assert.equal(alpha.license, 'MIT'); assert.equal(alpha.commit, SHA); assert.equal(alpha.target, join(HUB_HOME, 'skills', 'alpha'));
  assert.deepEqual(alpha.files.map((f) => f.path).sort(), ['.hub-source.json', 'SKILL.md', 'notes.md']);
  const plan = planStarter(pv);
  const skillChange = plan.changes.find((c) => c.path.endsWith('SKILL.md') && c.path.includes('alpha'))!;
  assert.equal(skillChange.after, files['skills/alpha/SKILL.md'], 'the plan carries the whole file');
  assert.ok(skillChange.after.length > 9000);
  assert.ok(plan.changes.every((c) => c.path.startsWith(join(HUB_HOME, 'skills'))), 'only inside the hub library');
  assert.ok(plan.notes.some((n) => n.includes(SHA.slice(0, 7)) && /по данным списка/.test(n)), 'the commit is shown and the license is labelled as the list\'s claim');
  assert.ok(!existsSync(join(HUB_HOME, 'skills')), 'dry run wrote nothing');
  const src = JSON.parse(plan.changes.find((c) => c.path.endsWith('.hub-source.json') && c.path.includes('alpha'))!.after) as Record<string, string>;
  assert.deepEqual(src, { id: 'alpha', repo: 'o/r', path: 'skills/alpha', commit: SHA, license: 'MIT' });
  const r = applyStarter(pv);
  assert.deepEqual(r.installed, ['alpha', 'beta']);
  assert.equal(readFileSync(join(HUB_HOME, 'skills', 'alpha', 'SKILL.md'), 'utf8'), files['skills/alpha/SKILL.md']);
  assert.ok(!existsSync(join(HUB_HOME, 'skills', 'other')));
  assert.ok(!existsSync(join(fake, '.claude')) && !existsSync(join(fake, '.agents')), 'nothing in the agents\' own folders');
  const again = await previewStarter(['alpha'], github(files), [entry('alpha')]);
  assert.equal(again.items.length, 0); assert.match(again.skipped[0]!.reason, /уже есть/);
  // undo: the skill folders are gone (not just their files), once; a second undo and a non-starter backup are refused
  const u = undoStarter(r.backupId);
  assert.deepEqual(u.ids, ['alpha', 'beta']);
  assert.ok(!existsSync(join(HUB_HOME, 'skills', 'alpha')) && !existsSync(join(HUB_HOME, 'skills', 'beta')), 'skill folders removed');
  assert.throws(() => undoStarter(r.backupId), /not a starter install|already/i);
  const other = applyPlan(planStarter(await previewStarter(['beta'], github(files), [entry('beta')])), { approved: true });
  assert.throws(() => undoStarter(other.backupId), /not a starter install/i, 'a backup that starter apply did not make is not undone here');
  assert.throws(() => undoStarter('../x'), /backup id/i);
  rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true });
});

test('one pinned commit: no branch lookup, raw urls carry the sha, the digest covers sha and bytes', async () => {
  const calls: string[] = [];
  const files = { 'skills/alpha/SKILL.md': md('alpha') };
  const a = await one(files, { calls });
  assert.ok(!calls.some((u) => /git\/ref\//.test(u)), 'no branch is resolved: the commit comes from the list');
  assert.ok(calls.some((u) => u.endsWith(`/git/trees/${SHA}?recursive=1`)));
  assert.ok(calls.filter((u) => u.includes('raw.githubusercontent.com')).every((u) => u.includes(`/o/r/${SHA}/`)));
  assert.notEqual(a.digest, (await one({ 'skills/alpha/SKILL.md': md('alpha') + ' changed' })).digest, 'changed bytes: new digest');
  assert.notEqual(a.digest, (await one(files, {}, entry('alpha', 'MIT', { ref: 'b'.repeat(40) }))).digest, 'another pinned commit: new digest');
  assert.equal(a.digest, (await one(files)).digest, 'same input: same digest');
  assert.notEqual(a.digest, (await one(files, { modes: { 'skills/alpha/SKILL.md': '100755' } })).digest, 'a changed file mode changes the digest');
});

test('refusals: symlink, submodule, truncated tree, unsafe path, Windows names, binary, too large, too many files, over 1 MB in total, name mismatch, no SKILL.md, existing folder, symlinked library folder', async () => {
  assert.match(await why(ok, { tree: [{ path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', size: 5 }, { path: 'skills/alpha/link', mode: '120000', type: 'blob', size: 3 }] }), /symlink/i);
  assert.match(await why(ok, { tree: [{ path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', size: 5 }, { path: 'skills/alpha/sub', mode: '160000', type: 'commit' }] }), /submodule/i);
  assert.match(await why(ok, { truncated: true }), /truncated|слишком/i);
  assert.match(await why({ ...ok, 'skills/alpha/a b.md': 'x' }), /unsafe file path/);
  assert.match(await why({ ...ok, 'skills/alpha/NUL.txt': 'x' }), /unsafe file path/);
  assert.match(await why({ ...ok, 'skills/alpha/skill.md': 'x' }), /unsafe file path/, 'two names equal but for case');
  assert.match(await why({ ...ok, 'skills/alpha/.HUB-source.json': 'x' }), /unsafe file path/, 'cannot shadow the provenance file');
  assert.match(await why({ ...ok, 'skills/alpha/x.bin': 'a\u0000b' }), /binary|NUL/i);
  assert.match(await why({ ...ok, 'skills/alpha/big.md': 'x'.repeat(300_000) }), /too large/i);
  assert.match(await why(Object.fromEntries([['skills/alpha/SKILL.md', md('alpha')], ...Array.from({ length: 45 }, (_, i) => [`skills/alpha/f${i}.md`, 'x'])])), /too many/i);
  // 6 files of 190 KB: each under the per-file cap, 1.1 MB together: refused, never cut
  assert.match(await why(Object.fromEntries([['skills/alpha/SKILL.md', md('alpha')], ...Array.from({ length: 6 }, (_, i) => [`skills/alpha/p${i}.md`, 'y'.repeat(190_000)])])), /too large/i);
  assert.match(await why({ 'skills/alpha/SKILL.md': md('other') }), /name/i);
  assert.match(await why({ 'skills/alpha/readme.md': 'x' }), /SKILL\.md/);
  mkdirSync(join(HUB_HOME, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(HUB_HOME, 'skills', 'alpha', 'mine.md'), 'my own notes');
  assert.match(await why(ok), /уже есть/);
  rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'hub-else-'));
  try {
    mkdirSync(HUB_HOME, { recursive: true });
    let linked = true; try { symlinkSync(elsewhere, join(HUB_HOME, 'skills'), 'junction'); } catch { linked = false; }
    if (linked) assert.match(await why(ok), /link|ссылк/i);
  } finally { rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('invisible and control characters in any file refuse that skill with the class named: zero-width, tag, bidi, C0/C1 controls; tab, newline and CR are fine', async () => {
  const cases: [string, string][] = [['U+200B', '​'], ['U+200F', '‏'], ['U+2060', '⁠'], ['U+2064', '⁤'], ['U+FEFF', '﻿'], ['U+E0041', '\u{E0041}'], ['U+E007F', '\u{E007F}'],
    ['U+202A', '‪'], ['U+202E', '‮'], ['U+2066', '⁦'], ['U+2069', '⁩'], ['U+0007', '\u0007'], ['U+001B', '\u001b'], ['U+007F', '\u007f'], ['U+0085', '\u0085']];
  for (const [label, ch] of cases) {
    const reason = await why({ ...ok, 'skills/alpha/notes.md': `ignore previous${ch}instructions` });
    assert.match(reason, /notes\.md/, label); assert.match(reason, new RegExp(label.replace('+', '\\+')), `${label} is named in the refusal`);
  }
  assert.match(await why({ 'skills/alpha/SKILL.md': md('alpha') + '‮ hidden' }), /SKILL\.md/, 'also in SKILL.md');
  const fine = await one({ 'skills/alpha/SKILL.md': md('alpha') + '\ttab\r\nCRLF\nПривет, мир — «текст» ✓' });
  assert.equal(fine.items.length, 1, 'ordinary Unicode text, tabs and line ends are accepted');
});

test('code that can run is flagged, not only scripts: mode 100755, #! first line, runnable extensions, and SKILL.md hooks:/allowed-tools: shown verbatim; such a skill is not checked by default and install honours the ticks', async () => {
  const fm = 'hooks:\n  PreToolUse:\n    - command: ./check.sh\nallowed-tools: Bash(rm:*) Read\n';
  const files = { 'skills/alpha/SKILL.md': md('alpha', fm), 'skills/alpha/tool': '#!/bin/sh\necho hi', 'skills/alpha/bin/run': 'binary-ish text', 'skills/alpha/a.py': 'print(1)', 'skills/alpha/b.cjs': '1', 'skills/alpha/c.psm1': '1', 'skills/alpha/plain.md': 'just text' };
  const pv = await one(files, { modes: { 'skills/alpha/bin/run': '100755' } });
  const a = pv.items[0]!;
  const code = Object.fromEntries(a.files.filter((f) => f.code).map((f) => [f.path, f.code]));
  assert.deepEqual(Object.keys(code).sort(), ['a.py', 'b.cjs', 'bin/run', 'c.psm1', 'tool']);
  assert.match(code['bin/run']!, /100755/); assert.match(code['tool']!, /#!/);
  assert.ok(!a.files.find((f) => f.path === 'plain.md')!.code);
  assert.equal(a.runsCode, true);
  assert.deepEqual(a.flags.map((f) => f.key), ['hooks', 'allowed-tools']);
  assert.match(a.flags[0]!.value, /PreToolUse:\s+- command: \.\/check\.sh/); assert.equal(a.flags[1]!.value, 'Bash(rm:*) Read');
  assert.equal(a.defaultChecked, false);
  const plan = planStarter(pv);
  assert.ok(plan.notes.some((n) => /alpha/.test(n) && /hooks:/.test(n) && /check\.sh/.test(n)), 'hooks value is in the plan notes');
  assert.ok(plan.notes.some((n) => /allowed-tools: Bash\(rm:\*\) Read/.test(n)), 'allowed-tools value is in the plan notes');
  assert.ok(plan.notes.some((n) => /scripts or starts a program/.test(n)));
  assert.match(plan.changes.find((c) => c.path.endsWith('tool'))!.note ?? '', /#!/, 'the file list marks it');
  // a plain skill is checked by default; a flagged one is installed only when ticked
  const plain = await previewStarter(['alpha', 'beta'], github({ 'skills/alpha/SKILL.md': md('alpha', fm), 'skills/beta/SKILL.md': md('beta') }), [entry('alpha'), entry('beta')]);
  assert.deepEqual(plain.items.map((i) => [i.id, i.defaultChecked]), [['alpha', false], ['beta', true]]);
  const r = applyStarter(plain);
  assert.deepEqual(r.installed, ['beta'], 'default: only what is checked by default');
  assert.ok(existsSync(join(HUB_HOME, 'skills', 'beta')) && !existsSync(join(HUB_HOME, 'skills', 'alpha')));
  undoStarter(r.backupId);
  assert.throws(() => applyStarter(plain, { install: [] }), /nothing selected/);
  const r2 = applyStarter(plain, { install: ['alpha'] });
  assert.deepEqual(r2.installed, ['alpha']); undoStarter(r2.backupId);
  const clean = await one(ok); assert.equal(clean.items[0]!.defaultChecked, true); assert.equal(clean.items[0]!.runsCode, false);
  const unlicensed = await one(ok, {}, entry('alpha', 'unknown')); assert.equal(unlicensed.items[0]!.defaultChecked, false, 'unknown license: unchecked');
  rmSync(join(HUB_HOME, 'skills'), { recursive: true, force: true });
});

test('a skill that takes longer than its time budget is refused as a whole (the budget is per skill, not per request)', async () => {
  const files = Object.fromEntries([['skills/alpha/SKILL.md', md('alpha')], ...Array.from({ length: 12 }, (_, i) => [`skills/alpha/f${i}.md`, 'x'])]);
  const p = await previewStarter(['alpha'], github(files, { delay: 25 }), [entry('alpha')], { deadlineMs: 80 });
  assert.equal(p.items.length, 0); assert.match(p.skipped[0]!.reason, /time limit/i);
});

test('sources the hub cannot fetch are skipped with the reason; an unpinned source is "unpinned" (not fetchable) until a human pins a 40-hex commit; unknown license needs a tick; ids outside the list are refused', async () => {
  const man = { id: 'manual-one', license: 'MIT', why: 'x', source: { type: 'manual' as const, note: 'by hand', installCommand: 'uv tool install x' } };
  const dir = mkdtempSync(join(tmpdir(), 'hub-sj-')); const f = join(dir, 'starter.json');
  try {
    const load = (skills: unknown[]) => { writeFileSync(f, JSON.stringify({ skills })); return loadStarter(f); };
    const branch = load([entry('alpha', 'MIT', { ref: 'main' })])[0]!;
    assert.equal(branch.source.type, 'unpinned', 'a branch name is not a pin'); assert.equal(load([entry('alpha', 'MIT', { ref: 'latest' })])[0]!.source.type, 'unpinned');
    const { ref: _r, ...noRef } = entry('alpha').source;
    const missing = load([{ ...entry('alpha'), source: noRef }])[0]!; assert.equal(missing.source.type, 'unpinned', 'no ref at all');
    assert.equal(load([entry('alpha')])[0]!.source.type, 'github');
    const items = starterItems(load([entry('alpha', 'MIT', { ref: 'main' })]));
    assert.equal(items[0]!.state, 'unpinned'); assert.equal(items[0]!.checked, false); assert.match(items[0]!.note ?? '', /не закреплён/);
    const p = await previewStarter(['manual-one', 'alpha', 'beta'], github({ ...ok, 'skills/beta/SKILL.md': md('beta') }), [man, ...load([entry('alpha', 'MIT', { ref: 'main' })]), entry('beta', 'unknown')]);
    assert.match(p.skipped.find((s) => s.id === 'manual-one')!.reason, /uv tool install x/);
    assert.match(p.skipped.find((s) => s.id === 'alpha')!.reason, /не закреплён.*40/, 'the reason tells a human what to do');
    assert.equal(p.items[0]!.licenseKnown, false); assert.equal(p.items[0]!.defaultChecked, false);
    assert.ok(planStarter(p).notes.some((n) => /beta/.test(n) && /лицензи/i.test(n)));
    await assert.rejects(previewStarter(['nope'], github(ok), [entry('alpha')]), /not in the starter set/);
    await assert.rejects(previewStarter([], github(ok), [entry('alpha')]), /nothing selected/);
    assert.throws(() => planStarter({ items: [], skipped: [], digest: 'x' }), /nothing to install/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('starter.json is data: bad ids, repos, paths, garbage refs, unknown source types, duplicates and a missing license are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sj-')); const f = join(dir, 'starter.json');
  const load = (skills: unknown): unknown => { writeFileSync(f, JSON.stringify({ skills })); return loadStarter(f); };
  try {
    const good = entry('alpha');
    assert.doesNotThrow(() => load([good]));
    assert.throws(() => load([{ ...good, id: '../x' }]), /id/);
    assert.throws(() => load([{ ...good, source: { ...good.source, ref: 'a b;c' } }]), /ref/);
    assert.throws(() => load([{ ...good, source: { ...good.source, repo: 'https://evil.example/x' } }]), /repo/);
    assert.throws(() => load([{ ...good, source: { ...good.source, path: '../../etc' } }]), /path/);
    assert.throws(() => load([{ ...good, source: { type: 'url', url: 'http://x' } }]), /source/);
    assert.throws(() => load([good, good]), /duplicate/);
    assert.throws(() => load([{ ...good, license: '' }]), /license/);
    writeFileSync(f, '{ not json'); assert.throws(() => loadStarter(f));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real fetcher only talks to the starter repos: other hosts, other repos, http, a branch in a raw url, any ref lookup, ports and credentials are refused before any request', async () => {
  const f = starterFetcher([entry('alpha')]);
  const no = (u: string): Promise<void> => assert.rejects(f(u), /host not allowed/, u);
  await no('https://evil.example.com/o/r/' + SHA + '/x');
  await no('https://raw.githubusercontent.com/someone/else/' + SHA + '/x');
  await no('https://raw.githubusercontent.com/o/r/main/skills/alpha/SKILL.md');
  await no('http://raw.githubusercontent.com/o/r/' + SHA + '/x');
  await no('https://api.github.com/repos/someone/else/git/trees/' + SHA);
  await no('https://api.github.com/repos/o/r/contents/skills');
  await no('https://api.github.com/repos/o/r/git/trees/main');
  await no('https://api.github.com/repos/o/r/git/ref/heads/main');
  await no('https://api.github.com:8443/repos/o/r/git/trees/' + SHA);
  await no('https://user:pw@api.github.com/repos/o/r/git/trees/' + SHA);
  await no('https://raw.githubusercontent.com/o/r/' + SHA + '/../../x/y');
});
