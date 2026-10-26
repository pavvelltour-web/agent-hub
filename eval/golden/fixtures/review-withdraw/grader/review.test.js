import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
test('REVIEW.md names the missing balance check in withdraw', () => {
  assert.ok(existsSync('REVIEW.md'), 'REVIEW.md is missing');
  const t = readFileSync('REVIEW.md', 'utf8');
  assert.match(t, /account\.js:\d+/);
  assert.match(t, /withdraw/i);
  assert.match(t, /negative|insufficient|overdr|exceed|balance/i);
});
test('account.js was not edited', () => assert.match(readFileSync('account.js', 'utf8'), /this\.balance -= amount;/));
