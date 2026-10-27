import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-inst-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
process.env['HUB_GRAPHIFY'] = 'off';   // graph features are tested on their own; these tests must not depend on whether this PC has graphify
const mk = (p: string, t: string): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };
mk(join(fake, '.agents', 'skills', 'graphify', 'SKILL.md'), '---\nname: graphify\ndescription: Graph.\nlicense: MIT\n---\nv1');
// Claude plugin cache + settings, Codex config
mk(join(fake, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@official': true, 'firebase@official': true, 'aws-serverless@official': false } }));
mk(join(fake, '.claude', 'plugins', 'cache', 'official', 'firebase', '1.0', 'skills', 'fb', 'SKILL.md'), '---\nname: fb\ndescription: Firebase things for apps.\n---\n');
mk(join(fake, '.claude', 'plugins', 'cache', 'official', 'superpowers', '1.0', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Test first.\n---\n');
mk(join(fake, '.codex', 'config.toml'), '[plugins."firebase@official"]\nenabled = true\n\n[plugins."superpowers@official"]\nenabled = true\n');

const { planInit } = await import('./init.ts');
const { applyPlan } = await import('./plan.ts');
const { planInstall } = await import('./install.ts');
const { listPlugins } = await import('./profile.ts');

test('install: a fresh checkout gets its skill links back from hub.lock; a changed source is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-proj-'));
  applyPlan(planInit(root, { type: 'automation' }), { approved: true });
  // simulate a clone: lock/config are in git, links are not
  rmSync(join(root, '.claude'), { recursive: true, force: true }); rmSync(join(root, '.agents'), { recursive: true, force: true });
  const a = planInstall(root);
  assert.ok(a.items.find((i) => i.id === 'skill/graphify')?.status === 'ok');
  assert.equal(a.plan.changes.filter((c) => c.action === 'link').length, 2);
  applyPlan(a.plan, { approved: true });
  assert.ok(existsSync(join(root, '.claude', 'skills', 'graphify', 'SKILL.md')));
  assert.equal(planInstall(root).plan.changes.length, 0, 'second install is a no-op');
  writeFileSync(join(fake, '.agents', 'skills', 'graphify', 'SKILL.md'), '---\nname: graphify\ndescription: Graph.\nlicense: MIT\n---\nTAMPERED');
  rmSync(join(root, '.claude'), { recursive: true, force: true });
  const b = planInstall(root);
  assert.equal(b.items.find((i) => i.id === 'skill/graphify')?.status, 'hash-changed');
  assert.equal(b.plan.changes.length, 0, 'nothing from a changed source is installed');
  assert.throws(() => planInstall(mkdtempSync(join(tmpdir(), 'hub-empty-'))), /hub init/);
});

test('plugin list: user plugins with token cost, unrelated ones suggested, disabled ones marked', () => {
  const p = listPlugins();
  const fb = p.claude.find((x) => x.name === 'firebase')!;
  assert.equal(fb.skills, 1); assert.ok(fb.tokens > 0); assert.equal(fb.suggestDisable, true);
  assert.equal(p.claude.find((x) => x.name === 'superpowers')!.suggestDisable, false);
  assert.equal(p.claude.find((x) => x.name === 'aws-serverless')!.enabled, false);
  assert.deepEqual(p.codex.map((x) => x.name).sort(), ['firebase', 'superpowers']);
});
