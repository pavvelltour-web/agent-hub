import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fake = mkdtempSync(join(tmpdir(), 'hub-tpl-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub'); process.env['APPDATA'] = join(fake, 'AppData', 'Roaming');
// one skill on this "PC" so the type's skill links have something to link
const sk = join(fake, 'skills-src', 'graphify'); mkdirSync(sk, { recursive: true });
writeFileSync(join(sk, 'SKILL.md'), '---\nname: graphify\ndescription: Knowledge graph for agents.\nlicense: MIT\n---\nbody');
const { planNewProject, applyNewProject, TEMPLATE_TYPES } = await import('./templates.ts');
const { addSkillRoot, HUB_HOME } = await import('./registry.ts');
const { renderRules } = await import('./compilers.ts');
const { readVerify } = await import('../run/cascade.ts');
const { planVerify, approveVerify, runCheck } = await import('../review/checks.ts');
const { git } = await import('../run/git.ts');
addSkillRoot(join(fake, 'skills-src'));
process.on('exit', () => { try { rmSync(fake, { recursive: true, force: true }); } catch { /* best effort */ } });

const made: string[] = [];
const fresh = (name = 'proj'): string => join(mkdtempSync(join(tmpdir(), 'hub-tplp-')), name);
const apply = (type: string, folder: string) => { made.push(folder); return applyNewProject(planNewProject(type, folder), { approved: true }); };
process.on('exit', () => { for (const f of made) try { rmSync(join(f, '..'), { recursive: true, force: true }); } catch { /* best effort */ } });
const TYPES = ['web-saas', 'mobile-app', 'automation', 'design-study'];

test('the four project types have a template; no template file is one npm drops from a package (.gitignore, .npmignore)', () => {
  assert.deepEqual([...TEMPLATE_TYPES].sort(), [...TYPES].sort());
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');
  for (const t of TYPES) {
    for (const f of ['brief.md', 'docs/architecture.md', 'hub.json', 'gitignore']) assert.ok(existsSync(join(root, t, ...f.split('/'))), `${t}/${f}`);
    for (const f of ['.gitignore', '.npmignore']) assert.ok(!existsSync(join(root, t, f)), `${t}/${f} would be left out of the npm package`);
  }
});

test('refusals: a non-empty folder (even only a dot-folder), a file, an unknown type, a drive root, secrets, the agents\' own folders and the hub home; nothing is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tplr-')); made.push(join(dir, 'x'));
  try {
    const full = join(dir, 'full'); mkdirSync(full); writeFileSync(join(full, 'a.txt'), '1');
    assert.throws(() => planNewProject('web-saas', full), /not empty/i);
    const dot = join(dir, 'dot'); mkdirSync(join(dot, '.git'), { recursive: true });
    assert.throws(() => planNewProject('web-saas', dot), /not empty/i, 'a folder that holds only .git is not empty');
    const file = join(dir, 'f.txt'); writeFileSync(file, 'x');
    assert.throws(() => planNewProject('web-saas', file), /not a folder/i);
    assert.throws(() => planNewProject('nope', join(dir, 'ok')), /unknown project type/i);
    assert.throws(() => planNewProject('../web-saas', join(dir, 'ok')), /unknown project type/i);
    assert.throws(() => planNewProject('web-saas', 'C:\\'), /root/i);
    assert.throws(() => planNewProject('web-saas', join(dir, 'secrets')), /not allowed/i);
    assert.throws(() => planNewProject('web-saas', join(dir, '.env')), /not allowed/i);
    for (const p of [join(fake, '.claude', 'p'), join(fake, '.codex'), join(fake, '.agents', 'skills', 'p'), join(fake, 'AppData', 'Roaming', 'Claude', 'p'), join(HUB_HOME, 'p')]) assert.throws(() => planNewProject('web-saas', p), /agent|hub/i, p);
    assert.throws(() => planNewProject('web-saas', ''), /folder/i);
    assert.ok(!existsSync(join(dir, 'ok')) && !existsSync(join(fake, '.claude')), 'planning created nothing');
    // an existing EMPTY folder is fine, and so is a folder that does not exist yet
    const empty = join(dir, 'empty'); mkdirSync(empty);
    assert.doesNotThrow(() => planNewProject('web-saas', empty)); assert.doesNotThrow(() => planNewProject('web-saas', join(dir, 'new', 'deeper')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plan per type: skeleton files, AGENTS.md from renderRules with the type section, CLAUDE.md pointer, REVIEW.md, merged hub.json with verify, linked skills, git init as an argv step; dry run writes nothing', () => {
  const section: Record<string, RegExp> = { 'web-saas': /Rules for a web product/, 'mobile-app': /Rules for a mobile app/, automation: /Rules for automations, bots and agents/, 'design-study': /Rules for a design study/ };
  for (const type of TYPES) {
    const folder = fresh('мой проект ' + type);
    const plan = planNewProject(type, folder);
    const rel = (p: string): string => p.slice(folder.length + 1).replace(/\\/g, '/');
    const byRel = Object.fromEntries(plan.changes.map((c) => [rel(c.path), c]));
    for (const f of ['brief.md', 'docs/architecture.md', '.gitignore', 'hub.json', 'AGENTS.md', 'CLAUDE.md', 'REVIEW.md', 'toolkit.json']) assert.ok(byRel[f], `${type}: ${f}`);
    const name = 'мой проект ' + type;
    assert.equal(byRel['AGENTS.md']!.after, renderRules(name, type), 'AGENTS.md is exactly the rendered rules');
    assert.match(byRel['AGENTS.md']!.after, section[type]!);
    assert.equal(byRel['CLAUDE.md']!.after, '@AGENTS.md\n');
    for (const f of ['brief.md', 'docs/architecture.md']) { assert.ok(byRel[f]!.after.includes(name), `${f} names the project`); assert.ok(!byRel[f]!.after.includes('{{'), `${f}: no placeholder left`); }
    const cfg = JSON.parse(byRel['hub.json']!.after) as { version: number; project: { slug: string; type: string }; verify: string[] };
    assert.equal(cfg.version, 1); assert.equal(cfg.project.type, type); assert.equal(cfg.project.slug, name);
    assert.ok(Array.isArray(cfg.verify) && cfg.verify.length > 0 && cfg.verify.every((a) => typeof a === 'string'), 'verify is an argv list');
    assert.deepEqual(plan.verify, cfg.verify);
    assert.ok(plan.changes.some((c) => c.action === 'link' && /graphify$/.test(c.path)), `${type}: the type's skills are linked`);
    assert.deepEqual(plan.steps.map((s) => s.argv), [['git', 'init', '-b', 'main']]); assert.equal(plan.steps[0]!.cwd, folder);
    assert.ok(plan.notes.some((n) => /verify/i.test(n) && /не одобрен|not approved/i.test(n)), 'the plan says verify is not approved');
    assert.ok(plan.changes.every((c) => c.path.startsWith(folder)), 'every write is inside the new folder');
    assert.ok(!existsSync(folder), 'dry run wrote nothing, not even the folder');
    rmSync(join(folder, '..'), { recursive: true, force: true });
  }
});

test('every template\'s verify runs green on the empty skeleton and goes red when the skeleton is broken; Cyrillic and space in the path work end to end', async () => {
  for (const type of TYPES) {
    const folder = fresh('проект с пробелом ' + type);
    const r = apply(type, folder);
    assert.ok(existsSync(join(folder, '.git')), 'git init ran'); assert.equal(r.steps[0]!.ok, true);
    const verify = readVerify(folder)!;
    assert.ok(verify, `${type}: hub.json has a valid verify`);
    const res = await runCheck(folder, verify);
    assert.equal(res.ok, true, `${type}: ${res.tail}`);
    rmSync(join(folder, 'docs', 'architecture.md'));
    assert.equal((await runCheck(folder, verify)).ok, false, `${type}: a missing skeleton file fails the check`);
  }
});

test('verify is NOT approved by creating a project: the digest-pinned approval is still required, and works for exactly the shown plan', () => {
  const folder = fresh('appr');
  apply('web-saas', folder);
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  assert.ok(git(folder, ['add', '-A'], { ...process.env, ...env }).ok); assert.ok(git(folder, ['commit', '-q', '-m', 'skeleton'], { ...process.env, ...env }).ok);
  const sha = git(folder, ['rev-parse', 'HEAD']).out;
  const verify = readVerify(folder)!;
  assert.ok(!existsSync(join(HUB_HOME, 'review-checks-approved.json')), 'nothing was approved while creating the project');
  const p = planVerify(folder, folder, sha, HUB_HOME, verify);
  assert.equal(p.approved, false); assert.deepEqual(p.checks, [verify]);
  assert.throws(() => approveVerify(folder, folder, sha, 'f'.repeat(64), HUB_HOME, verify), /changed since/);
  assert.equal(approveVerify(folder, folder, sha, p.digest, HUB_HOME, verify).approved, true);
});

test('apply: needs approval; re-checks that the folder is still empty; runs only the planned steps; one backup that undo can use', async () => {
  const folder = fresh('guard');
  const plan = planNewProject('automation', folder);
  assert.throws(() => applyNewProject(plan, { approved: false }), /not approved/);
  assert.ok(!existsSync(folder));
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'late.txt'), 'someone was faster');
  assert.throws(() => applyNewProject(plan, { approved: true }), /not empty/i);
  assert.ok(!existsSync(join(folder, 'AGENTS.md')) && !existsSync(join(folder, '.git')), 'nothing written into a folder that filled up after the plan');
  // a tampered step list is not executed
  const folder2 = fresh('tamper'); const p2 = planNewProject('automation', folder2); made.push(folder2);
  assert.throws(() => applyNewProject({ ...p2, steps: [{ argv: ['cmd', '/c', 'calc'], cwd: folder2, note: 'x' }] }, { approved: true }), /step/i);
  assert.throws(() => applyNewProject({ ...p2, steps: [{ argv: ['git', 'init', '-b', 'main'], cwd: join(folder2, '..'), note: 'x' }] }, { approved: true }), /step/i);
  assert.ok(!existsSync(folder2));
  const r = applyNewProject(p2, { approved: true });
  assert.ok(r.backupId && existsSync(join(folder2, 'AGENTS.md')));
  assert.ok(lstatSync(join(folder2, '.git')).isDirectory());
});

test('hub new <type> <folder>: shows the plan without --yes (not a terminal), writes with --yes, refuses a non-empty folder with a non-zero exit', () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hub.js');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...args], { encoding: 'utf8', env: { ...process.env, USERPROFILE: fake, HOME: fake, AGENT_HUB_HOME: join(fake, '.agent-hub') }, input: '', timeout: 60_000 });
  const folder = fresh('cli proj'); made.push(folder);
  const shown = run('new', 'automation', folder);
  assert.equal(shown.status, 0); assert.match(shown.stdout, /nothing is written until you confirm/); assert.match(shown.stdout, /not a terminal/); assert.ok(!existsSync(folder), 'no --yes: nothing written');
  const done = run('new', 'automation', folder, '--yes');
  assert.equal(done.status, 0, done.stderr); assert.match(done.stdout, /ok\s+git init -b main/); assert.ok(existsSync(join(folder, 'AGENTS.md')) && existsSync(join(folder, '.git')));
  const again = run('new', 'automation', folder, '--yes');
  assert.notEqual(again.status, 0); assert.match(again.stderr, /not empty/);
  assert.notEqual(run('new', 'nope', fresh('x'), '--yes').status, 0); assert.notEqual(run('new', 'automation').status, 0);
});
