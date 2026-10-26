import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFetcher, fetchAitmpl, searchGithub } from './scout-remote.ts';
import { scout } from './scout.ts';

const sample = { components: [
  { id: 'skills/testing/e2e-runner', type: 'skills', name: 'e2e-runner', category: 'testing', description: 'Run browser end to end tests for web apps', license: 'MIT', install: { command: 'npx claude-code-templates@latest --skill testing/e2e-runner' } },
  { id: 'skills/cooking/recipes', type: 'skills', name: 'recipes', category: 'cooking', description: 'Cooking recipes' },
  { type: 'skills' },
] };

test('aitmpl: catalog entries become proposals with install command, unknown license kept unknown, never installed', async () => {
  let asked = '';
  const r = await fetchAitmpl('skills', async (u) => { asked = u; return sample; });
  assert.equal(asked, 'https://www.aitmpl.com/api/v1/catalog/skills.json');
  assert.equal(r.length, 2, 'entries without id/name are dropped');
  assert.equal(r[0]!.installCommand, 'npx claude-code-templates@latest --skill testing/e2e-runner');
  assert.equal(r[1]!.license, 'unknown'); assert.equal(r[0]!.sourceVerified, false);
  const hooks = await fetchAitmpl('hooks', async () => ({ components: [{ id: 'hooks/a/b', name: 'b', description: 'x' }] }));
  assert.equal(hooks[0]!.kind, 'hook'); assert.equal(hooks[0]!.risk.executesCode, true);
  const top = scout(r, { brief: 'browser tests for a web app', projectType: 'web-saas' });
  assert.equal(top[0]!.entry.title, 'e2e-runner');
});

test('fetcher only talks to aitmpl over https; github query is validated and gh failures are explained', async () => {
  await assert.rejects(defaultFetcher('https://evil.example.com/x.json'), /host not allowed/);
  await assert.rejects(defaultFetcher('http://www.aitmpl.com/x.json'), /host not allowed/);
  assert.throws(() => searchGithub('a; rm -rf /'), /query/);
  assert.throws(() => searchGithub('claude skills', () => ({ ok: false, out: '' })), /gh auth login/);
  const rows = searchGithub('claude skills', (args) => { assert.deepEqual(args.slice(0, 3), ['search', 'repos', 'claude skills']); return { ok: true, out: JSON.stringify([{ fullName: 'o/r', description: 'd', license: { key: 'mit' }, stargazersCount: 5, updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/o/r' }]) }; });
  assert.deepEqual([rows[0]!.id, rows[0]!.license, rows[0]!.installCommand], ['github/o/r', 'mit', 'git clone https://github.com/o/r']);
});

test('github query cannot start with a dash (would be read by gh as an option)', () => {
  assert.throws(() => searchGithub('--help', () => ({ ok: true, out: '[]' })), /query/);
  assert.throws(() => searchGithub('-x foo', () => ({ ok: true, out: '[]' })), /query/);
});
