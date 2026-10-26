import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
test('no source file mentions getUsr any more', () => {
  for (const f of readdirSync('.').filter((n) => n.endsWith('.js') && n !== 'rename.test.js')) assert.doesNotMatch(readFileSync(f, 'utf8'), /getUsr/, f);
});
test('behaviour is unchanged', async () => {
  const u = await import('./users.js'); const g = await import('./greet.js');
  assert.equal(u.getUser(1), 'ann'); assert.equal(g.greet(2), 'hi bob'); assert.equal(g.greet(9), 'hi stranger');
});
