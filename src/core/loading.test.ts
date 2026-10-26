import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-load-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const mk = (p: string, t: string): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };
const skill = (dir: string, name: string, desc: string): void => mk(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody`);
skill(join(fake, '.claude', 'skills'), 'claude-global', 'Loaded by Claude in every project. '.repeat(4));
skill(join(fake, '.agents', 'skills'), 'codex-global', 'Loaded by Codex in every project. '.repeat(4));
skill(join(fake, '.agents', 'skills'), 'graphify', 'Knowledge graph for agents.');
skill(join(fake, '.agent-hub', 'skills'), 'hub-only', 'Lives in the hub library and costs nothing until linked.');
mk(join(fake, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'firebase@official': true } }));
mk(join(fake, '.claude', 'plugins', 'cache', 'official', 'firebase', '1.0', 'skills', 'fb', 'SKILL.md'), '---\nname: fb\ndescription: Firebase things for apps and more words here.\n---\n');

const { scanLocalSkills, addSkillRoot } = await import('./registry.ts');
const { auditLoading, compileProfile, skillInfoFrom } = await import('./loading.ts');
const { applyPlan, undoBackup, effective } = await import('./plan.ts');
const { planInit } = await import('./init.ts');

test('visibility: each folder is attributed to the agent that loads it; hub library and added folders load nowhere', () => {
  const extra = mkdtempSync(join(tmpdir(), 'hub-extra-')); skill(extra, 'extra-skill', 'In a folder the user added.');
  addSkillRoot(extra);
  const by = Object.fromEntries(scanLocalSkills().map((e) => [e.title, e]));
  assert.deepEqual(by['claude-global']!.visibleTo, ['claude']); assert.deepEqual(by['claude-global']!.globalVisibleTo, ['claude']);
  assert.deepEqual(by['codex-global']!.visibleTo, ['codex']);
  assert.deepEqual(by['hub-only']!.visibleTo, []); assert.equal(by['hub-only']!.scope, 'hub');
  assert.deepEqual(by['extra-skill']!.visibleTo, []);
});

test('audit counts only what an agent really loads; a profile lowers it for this project and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-proj-'));
  const a0 = auditLoading(root);
  const names = (ag: string): string[] => a0.rows.filter((r) => r.agent === ag && r.kind === 'skill').map((r) => r.name).sort();
  assert.deepEqual(names('claude'), ['claude-global']); assert.deepEqual(names('codex'), ['codex-global', 'graphify']);
  assert.ok(a0.rows.some((r) => r.kind === 'plugin' && r.name === 'firebase' && r.agent === 'claude'));
  const before = a0.totals.claude.now; assert.equal(a0.totals.claude.baseline, before);
  const plan = effective({ root, changes: compileProfile(root, { skills: { 'claude-global': 'off', 'codex-global': 'off', graphify: 'off' }, plugins: { 'firebase@official': false } }, skillInfoFrom(scanLocalSkills())), notes: [] });
  assert.deepEqual(plan.changes.map((c) => c.path.slice(root.length + 1).replace(/\\/g, '/')).sort(), ['.claude/settings.local.json', '.codex/config.toml']);
  applyPlan(plan, { approved: true });
  const cj = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(cj, { skillOverrides: { 'claude-global': 'off' }, enabledPlugins: { 'firebase@official': false } });
  const toml = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[\[skills\.config\]\]\npath = ".*codex-global\/SKILL\.md"\nenabled = false/); assert.match(toml, /\[plugins\."firebase@official"\]\nenabled = false/);
  const a1 = auditLoading(root);
  assert.equal(a1.totals.claude.now, 0); assert.ok(a1.totals.claude.baseline > 0); assert.equal(a1.totals.codex.now, 0);
  assert.equal(a1.rows.find((r) => r.name === 'claude-global')!.state, 'off');
  assert.equal(compileProfile(root, { skills: { 'claude-global': 'off' } }).filter((c) => c.before !== c.after).length, 0, 'idempotent');
  assert.equal(auditLoading(mkdtempSync(join(tmpdir(), 'hub-other-'))).totals.claude.now, before, 'another project is untouched');
});

test('profile: "on" removes our override, name-only keeps a cheap listing, other settings keys survive, invalid JSON is never overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-prof-'));
  mk(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, skillOverrides: { a: 'off', b: 'off' } }));
  const c = compileProfile(root, { skills: { a: 'on', b: 'name-only' } })[0]!;
  assert.deepEqual(JSON.parse(c.after), { permissions: { allow: ['Bash(git status)'] }, skillOverrides: { b: 'name-only' } });
  const cleared = JSON.parse(compileProfile(root, { skills: { a: 'on', b: 'on' } })[0]!.after);
  assert.equal('skillOverrides' in cleared, false);
  assert.deepEqual(compileProfile(root, {}), []);
  writeFileSync(join(root, '.claude', 'settings.local.json'), '{bad');
  assert.throws(() => compileProfile(root, { skills: { a: 'off' } }), /not valid JSON/);
});

test('unlink: removing a tool from a project removes only the link, and undo puts it back', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-unlink-'));
  applyPlan(planInit(root, { type: 'automation' }), { approved: true });
  const link = join(root, '.claude', 'skills', 'graphify');
  assert.ok(existsSync(join(link, 'SKILL.md')));
  const r = applyPlan({ root, notes: [], changes: [{ path: link, action: 'unlink', before: null, after: '' }] }, { approved: true });
  assert.ok(!existsSync(link), 'link gone');
  assert.ok(existsSync(join(fake, '.agents', 'skills', 'graphify', 'SKILL.md')), 'the real skill is untouched');
  undoBackup(root, r.backupId);
  assert.ok(lstatSync(link).isSymbolicLink() || existsSync(join(link, 'SKILL.md')));
  mkdirSync(join(root, '.claude', 'skills', 'real'), { recursive: true });
  assert.throws(() => applyPlan({ root, notes: [], changes: [{ path: join(root, '.claude', 'skills', 'real'), action: 'unlink', before: null, after: '' }] }, { approved: true }), /not a link/);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'real')), 'a real folder is never deleted');
});

test('profile refuses names and states that could break out of the JSON/TOML it writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-bad-'));
  assert.throws(() => compileProfile(root, { plugins: { 'x"]\n[evil]\nenabled = true\n#': false } }), /unsafe tool name/);
  assert.throws(() => compileProfile(root, { skills: { '../../x': 'off' } }), /unsafe tool name/);
  assert.throws(() => compileProfile(root, { skills: { ok: 'maybe' as never } }), /unknown state/);
});

test('plugin suggestions depend on the project type: Firebase is suggested away for a bot but kept for a mobile app', () => {
  const mkType = (type: string): string => { const r = mkdtempSync(join(tmpdir(), 'hub-type-')); writeFileSync(join(r, 'hub.json'), JSON.stringify({ project: { type } })); return r; };
  const flag = (root: string): boolean | undefined => auditLoading(root).rows.find((x) => x.kind === 'plugin' && x.name === 'firebase')?.suggest;
  assert.equal(flag(mkType('automation')), true);
  assert.equal(flag(mkType('mobile-app')), false);
});
