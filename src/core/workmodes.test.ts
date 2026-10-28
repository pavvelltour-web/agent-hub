import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_ID } from '../econ/router.ts';
import { applyWorkMode, loadWorkModes, modeRules, parseWorkMode, pickModeReviewer, type ModeReviewer, type WorkMode } from './workmodes.ts';

const proj = (): { root: string; home: string } => {
  const base = mkdtempSync(join(tmpdir(), 'hub-wm-'));
  const root = join(base, 'Проект с пробелом'); mkdirSync(root);
  const home = join(base, 'home'); mkdirSync(home);
  return { root, home };
};
const link = (dir: string, name: string): void => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`); };
const mode = (id: string): WorkMode => loadWorkModes().find((m) => m.id === id) as WorkMode;

test('shipped work modes: five, in order, each valid; review is read-only', () => {
  const ms = loadWorkModes();
  assert.deepEqual(ms.map((m) => m.id), ['chat', 'task', 'interview', 'autopilot', 'review']);
  assert.equal(mode('review').permission, 'plan'); assert.equal(mode('chat').worktree, false); assert.equal(mode('task').worktree, true);
  assert.deepEqual(mode('autopilot').skills, ['autopilot']);
  for (const m of ms) assert.ok(m.title && m.hint && m.hint.length < 160, `${m.id}: one-line hint`);
});

test('parseWorkMode refuses malformed modes', () => {
  const ok = { id: 'x', title: 'X', hint: 'h', permission: 'edit', cls: 'implement', worktree: false, skills: [], review: 'none' };
  assert.equal(parseWorkMode(ok).id, 'x');
  for (const bad of [{ ...ok, permission: 'root' }, { ...ok, cls: 'wizard' }, { ...ok, id: '../x' }, { ...ok, review: 'sometimes' }, { ...ok, skills: ['a b'] }, { ...ok, autopilot: { mode: 'full', depth: 'insane' } }, { ...ok, worktree: 'yes' }]) assert.throws(() => parseWorkMode(bad), /work mode/);
});

test('autopilot: prefixes /autopilot <mode> <depth> for Claude when the skill is linked; asks to install it otherwise', () => {
  const { root, home } = proj();
  const req = { agent: 'claude' as const, prompt: 'сделай всё', projectRoot: root };
  assert.throws(() => applyWorkMode(mode('autopilot'), req, { home, library: [] }), /install the autopilot skill in Tools/);
  link(join(root, '.claude', 'skills'), 'autopilot');
  const r = applyWorkMode(mode('autopilot'), req, { home });
  assert.equal(r.prompt, '/autopilot semi normal сделай всё'); assert.equal(r.permission, 'edit'); assert.equal(r.mode, 'task');
  const deep = applyWorkMode({ ...mode('autopilot'), autopilot: { mode: 'full', depth: 'deep' } }, req, { home });
  assert.equal(deep.prompt, '/autopilot full deep сделай всё');
  const home2 = proj();   // a user-level Claude skill counts too
  link(join(home2.home, '.claude', 'skills'), 'autopilot');
  assert.equal(applyWorkMode(mode('autopilot'), { ...req, projectRoot: home2.root }, { home: home2.home }).prompt, '/autopilot semi normal сделай всё');
});

test('autopilot works with Claude only; a Codex-only skill folder does not count for Claude', () => {
  const { root, home } = proj();
  link(join(root, '.agents', 'skills'), 'autopilot');
  assert.throws(() => applyWorkMode(mode('autopilot'), { agent: 'codex', prompt: 'x', projectRoot: root }, { home }), /Claude/);
  assert.throws(() => applyWorkMode(mode('autopilot'), { agent: 'claude', prompt: 'x', projectRoot: root }, { home, library: [] }), /install the autopilot skill/);
});

test('review forces plan whatever was asked; other modes keep an explicit permission; prefixes and worktree come from the mode', () => {
  const { root, home } = proj();
  const base = { agent: 'claude' as const, prompt: 'look', projectRoot: root };
  assert.equal(applyWorkMode(mode('review'), { ...base, permission: 'full' }, { home }).permission, 'plan');
  assert.ok(applyWorkMode(mode('review'), base, { home }).prompt.startsWith('Review the current changes read-only.') && applyWorkMode(mode('review'), base, { home }).prompt.endsWith('look'));
  assert.equal(applyWorkMode(mode('chat'), { ...base, permission: 'full' }, { home }).permission, 'full');
  assert.equal(applyWorkMode(mode('chat'), base, { home }).prompt, 'look');
  assert.equal(applyWorkMode(mode('chat'), { ...base, cls: 'debug' }, { home }).cls, 'debug', 'an explicit class wins over the mode default');
  assert.equal(applyWorkMode(mode('task'), base, { home }).mode, 'task'); assert.equal(applyWorkMode(mode('chat'), base, { home }).mode, 'chat');
  assert.equal(applyWorkMode(mode('interview'), base, { home }).permission, 'plan');
});

test('autopilot keeps its own class (a lighter class would switch slash commands off); the applied request remembers the work mode', () => {
  const { root, home } = proj();
  link(join(root, '.claude', 'skills'), 'autopilot');
  const r = applyWorkMode(mode('autopilot'), { agent: 'claude', prompt: 'x', projectRoot: root, cls: 'mechanical' }, { home });
  assert.equal(r.cls, 'implement'); assert.equal(r.workMode, 'autopilot');
});

// ---- Task 5.3: shipped modes wired to installed skills and the cross-vendor reviewer ----

const noLib = { library: [] as never[] };   // the machine's own hub library must not decide a test

test('interview: links grill-me when it is there (claude only), runs without it and says so when it is not; skills stay on/off as ADR-020 says', () => {
  const { root, home } = proj();
  const req = { agent: 'claude' as const, prompt: 'идея', projectRoot: root };
  const plain = applyWorkMode(mode('interview'), req, { home, ...noLib });
  assert.ok(plain.prompt.startsWith('Before doing anything, interview me') && plain.prompt.endsWith('идея'), 'absent: no throw, no slash command'); assert.equal(plain.permission, 'plan');
  assert.deepEqual(mode('interview').skills, [], 'the mode itself still lists no skills (ADR-020: interview is off by default)');
  assert.deepEqual(mode('interview').skillsIfLinked, ['grill-me']);
  link(join(home, '.claude', 'skills'), 'grill-me');
  const linked = applyWorkMode(mode('interview'), req, { home, ...noLib });
  assert.ok(linked.prompt.startsWith('/grill-me Before doing anything, interview me') && linked.prompt.endsWith('идея'));
  assert.equal(linked.permission, 'plan', 'still read-only');
  const cx = applyWorkMode(mode('interview'), { ...req, agent: 'codex' }, { home, ...noLib });
  assert.ok(!cx.prompt.startsWith('/'), 'a Codex-only skill folder and no verified slash syntax: no /grill-me for Codex');
  const other = proj();   // a plain project-level folder does not count (N1: a clone can bring its own); see workmodes-fixes.test.ts
  link(join(other.root, '.claude', 'skills'), 'grill-me');
  assert.ok(!applyWorkMode(mode('interview'), { ...req, projectRoot: other.root }, { home: other.home, ...noLib, hubRoots: [] }).prompt.startsWith('/grill-me'));
});

test('autopilot: the refusal names the exact fix; a skill that is only in the hub library says "link", not "install"', () => {
  const { root, home } = proj();
  const req = { agent: 'claude' as const, prompt: 'go', projectRoot: root };
  assert.throws(() => applyWorkMode(mode('autopilot'), req, { home, ...noLib }), (e: Error) => /install the autopilot skill in Tools/.test(e.message) && e.message.includes("node bin/hub.js init '") && e.message.includes('--add skill/autopilot --yes') && /Установите навык autopilot/.test(e.message));
  const lib = [{ id: 'skill/autopilot', kind: 'skill', source: { type: 'local', path: 'x' }, scope: 'hub', visibleTo: [] }] as never[];
  assert.throws(() => applyWorkMode(mode('autopilot'), req, { home, library: lib }), (e: Error) => /in your hub library but not linked/.test(e.message) && e.message.includes('--add skill/autopilot') && !/install the autopilot skill/.test(e.message));
  link(join(root, '.claude', 'skills'), 'autopilot');
  assert.equal(applyWorkMode(mode('autopilot'), req, { home, library: lib }).prompt, '/autopilot semi normal go', 'linked wins over the library');
});

test('review: cross-vendor reviewer from the mode file: Codex when signed in, else Opus; both read-only; nobody signed in is a plain refusal', () => {
  const m = mode('review');
  assert.deepEqual(m.reviewer, { prefer: 'codex', fallback: 'claude' }); assert.equal(m.permission, 'plan'); assert.deepEqual(m.skills, []);
  const cx = pickModeReviewer(m, { claude: true, codex: true }) as ModeReviewer;
  assert.equal(cx.agent, 'codex'); assert.equal(cx.model, undefined, 'Codex keeps the account default model: no model id is guessed'); assert.match(cx.note, /Codex/);
  const op = pickModeReviewer(m, { claude: true, codex: false }) as ModeReviewer;
  assert.equal(op.agent, 'claude'); assert.equal(op.model, MODEL_ID.opus); assert.equal(op.effort, 'high'); assert.match(op.note, /Opus/);
  assert.throws(() => pickModeReviewer(m, { claude: false, codex: false }), /sign in to Codex or Claude/);
  assert.equal(pickModeReviewer(m, { claude: false, codex: true })?.agent, 'codex');
  assert.equal(pickModeReviewer(mode('chat'), { claude: true, codex: true }), undefined, 'a mode without reviewer data picks nothing');
  const { root, home } = proj();   // whoever reviews, the request stays read-only and the review prefix stays
  for (const agent of ['codex', 'claude'] as const) {
    const r = applyWorkMode(m, { agent, prompt: 'look', projectRoot: root, permission: 'full' }, { home, ...noLib });
    assert.equal(r.permission, 'plan'); assert.ok(r.prompt.startsWith('Review the current changes read-only.'));
  }
});

test('parseWorkMode: reviewer and skillsIfLinked are validated (names and agents only)', () => {
  const ok = { id: 'x', title: 'X', hint: 'h', permission: 'plan', cls: 'review', worktree: false, skills: [], review: 'none' };
  assert.deepEqual(parseWorkMode({ ...ok, reviewer: { prefer: 'codex', fallback: 'claude' }, skillsIfLinked: ['grill-me'] }).skillsIfLinked, ['grill-me']);
  for (const bad of [{ reviewer: { prefer: 'gemini', fallback: 'claude' } }, { reviewer: { prefer: 'codex' } }, { reviewer: 'codex' }, { skillsIfLinked: ['*'] }, { skillsIfLinked: ['../x'] }, { skillsIfLinked: 'grill-me' }]) assert.throws(() => parseWorkMode({ ...ok, ...bad }), /work mode/, JSON.stringify(bad));
});

// ---- teaching: rules by mode, skills by mode (orchestrator-map design, "Teaching") ----------------------------------------------------

test('every shipped mode names its rules file(s); the files exist, are English and bounded', () => {
  for (const m of loadWorkModes()) {
    assert.deepEqual(m.rules, [m.id], `${m.id}: rules`);
    const r = modeRules(m);
    assert.deepEqual(r.files, [m.id], `${m.id}: the file is found`);
    assert.ok(r.text.startsWith(`[mode rules: ${m.id}]\n`) && r.text.trimEnd().endsWith('[end mode rules]'), m.id);
    assert.ok(!/[\u0400-\u04FF]/.test(r.text), `${m.id}: English only`);
    assert.ok(r.text.length < 4500, `${m.id}: ${r.text.length} characters`);
  }
});

test('what each mode teaches: permission, worktree, skills and rules, pinned per mode', () => {
  const table = loadWorkModes().map((m) => [m.id, m.permission, m.worktree, m.skills.join('|'), (m.skillsIfLinked ?? []).join('|'), (m.rules ?? []).join('|')]);
  assert.deepEqual(table, [
    ['chat', 'edit', false, '*', '', 'chat'],
    ['task', 'edit', true, '*', '', 'task'],
    ['interview', 'plan', false, '', 'grill-me', 'interview'],
    ['autopilot', 'edit', true, 'autopilot', '', 'autopilot'],
    ['review', 'plan', false, '', '', 'review'],
  ]);
});

test('applyWorkMode with rules: the rules come first, then the mode prefix, then the user text; autopilot keeps its slash command first', () => {
  const { root, home } = proj();
  const req = { agent: 'claude' as const, prompt: 'USER-TEXT', projectRoot: root };
  assert.equal(applyWorkMode(mode('chat'), req, { home }).prompt, 'USER-TEXT', 'without the flag nothing is added (existing behaviour)');
  const chat = applyWorkMode(mode('chat'), req, { home, withRules: true }).prompt;
  assert.ok(chat.startsWith('[mode rules: chat]\n') && chat.endsWith('USER-TEXT'), chat.slice(0, 80));
  const iv = applyWorkMode(mode('interview'), req, { home, withRules: true }).prompt;
  const prefix = (mode('interview').promptPrefix as string).slice(0, 30);
  assert.ok(iv.indexOf('[mode rules: interview]') === 0 && iv.indexOf('[mode rules: interview]') < iv.indexOf(prefix) && iv.indexOf(prefix) < iv.indexOf('USER-TEXT'));
  link(join(root, '.claude', 'skills'), 'autopilot');
  const ap = applyWorkMode(mode('autopilot'), req, { home, withRules: true }).prompt;
  assert.ok(ap.startsWith('/autopilot semi normal USER-TEXT') && ap.indexOf('[mode rules: autopilot]') > ap.indexOf('USER-TEXT'), ap.slice(0, 80));
});

test('modeRules: a missing file is left out, an oversized file is cut with a marker, names must be plain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-wm-rules-'));
  writeFileSync(join(dir, 'big.md'), 'x'.repeat(10_000));
  writeFileSync(join(dir, 'ok.md'), 'Be brief.\n');
  const m = { ...mode('chat'), rules: ['ok', 'missing', 'big'] };
  const r = modeRules(m, dir);
  assert.deepEqual(r.files, ['ok', 'big']);
  assert.ok(r.text.includes('Be brief.') && r.text.includes('[rules truncated]') && r.text.length < 5000);
  assert.deepEqual(modeRules({ ...mode('chat'), rules: [] }, dir), { files: [], text: '' });
  const ok = { id: 'x', title: 'X', hint: 'h', permission: 'edit', cls: 'implement', worktree: false, skills: [], review: 'none' };
  for (const bad of [['../x'], ['a/b'], ['a b'], 'x', [1]]) assert.throws(() => parseWorkMode({ ...ok, rules: bad }), /bad rules/, JSON.stringify(bad));
  assert.deepEqual(parseWorkMode({ ...ok, rules: ['chat'] }).rules, ['chat']);
});

test('applyWorkMode with rules: a /grill-me slash command added for Interview stays first', () => {
  const { root, home } = proj();
  link(join(home, '.claude', 'skills'), 'grill-me');
  const p = applyWorkMode(mode('interview'), { agent: 'claude' as const, prompt: 'USER-TEXT', projectRoot: root }, { home, ...noLib, withRules: true }).prompt;
  assert.ok(p.startsWith('/grill-me Before doing anything, interview me'), p.slice(0, 60));
  assert.ok(p.indexOf('[mode rules: interview]') > p.indexOf('USER-TEXT') && p.endsWith('[end mode rules]'));
});
