import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-adopt-'));
process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const { adoptHooks, tokenize } = await import('./hooks-adopt.ts');
const { classifyHooks } = await import('./hooks.ts');
const { applyPlan } = await import('./plan.ts');
const { addSkillRoot, removeSkillRoot, loadUserConfig } = await import('./registry.ts');

test('tokenize: quotes become single arguments, shell syntax is refused', () => {
  assert.deepEqual(tokenize('node "C:/my tools/log.js" --x 1'), ['node', 'C:/my tools/log.js', '--x', '1']);
  for (const bad of ['a | b', 'a && b', 'a > f', 'echo $(x)', 'echo `x`', 'echo $HOME', 'echo %TEMP%', 'cd x']) assert.equal(tokenize(bad), undefined, bad);
  assert.equal(tokenize('node "unclosed'), undefined);
});

test('adopt: SessionStart/Stop become runner hooks, everything else is reported; applying keeps other keys and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-adopt-proj-'));
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ name: 'x', type: 'automation' }));
  const json = JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/start.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node end.js && echo done' }, { type: 'command', command: 'node save.js' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node after.js' }] }],
  } });
  const r = adoptHooks(root, classifyHooks(json, 'C:/plug'));
  assert.deepEqual(r.adopted.map((x) => [x.as, x.argv[0]]), [['sessionStart', 'node'], ['sessionEnd', 'node']]);
  assert.equal(r.skipped.length, 3, 'shell command, PreToolUse and PostToolUse are skipped with reasons');
  assert.ok(r.skipped.some((s) => /needs a shell/.test(s.why)) && r.skipped.some((s) => /no hub runner point/.test(s.why)));
  applyPlan(r.plan, { approved: true });
  const cfg = JSON.parse(readFileSync(join(root, 'hub.json'), 'utf8'));
  assert.equal(cfg.name, 'x'); assert.deepEqual(cfg.hooks.sessionStart, [['node', 'C:/plug/hooks/start.js']]); assert.deepEqual(cfg.hooks.sessionEnd, [['node', 'save.js']]);
  assert.equal(adoptHooks(root, classifyHooks(json, 'C:/plug')).plan.changes.length, 0, 'second adopt is a no-op');
  assert.throws(() => adoptHooks(mkdtempSync(join(tmpdir(), 'hub-none-')), []), /hub init/);
});

test('skill roots: validated, deduplicated, persisted in the hub home only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sr-'));
  addSkillRoot(dir); addSkillRoot(dir);
  assert.equal(loadUserConfig().extraSkillRoots?.length, 1);
  assert.throws(() => addSkillRoot(join(dir, 'missing')), /not found/);
  assert.throws(() => addSkillRoot(join(fake, '.codex', 'secrets')), /not allowed|not found/);
  removeSkillRoot(dir);
  assert.deepEqual(loadUserConfig().extraSkillRoots, []);
});

test('skill roots in plugin layout (<root>/plugin/skills/<name>) are scanned too', async () => {
  const { mkdirSync: mk } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'hub-pl-'));
  mk(join(dir, 'plugin', 'skills', 'my-design'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'skills', 'my-design', 'SKILL.md'), '---\nname: my-design\ndescription: Design pipeline.\n---\n');
  addSkillRoot(dir);
  const { scanLocalSkills } = await import('./registry.ts');
  assert.ok(scanLocalSkills().some((e) => e.id === 'skill/my-design'));
  removeSkillRoot(dir);
});
