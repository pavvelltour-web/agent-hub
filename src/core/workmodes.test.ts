import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWorkMode, loadWorkModes, parseWorkMode, type WorkMode } from './workmodes.ts';

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
  assert.throws(() => applyWorkMode(mode('autopilot'), req, { home }), /install the autopilot skill in Tools/);
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
  assert.throws(() => applyWorkMode(mode('autopilot'), { agent: 'claude', prompt: 'x', projectRoot: root }, { home }), /install the autopilot skill/);
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
