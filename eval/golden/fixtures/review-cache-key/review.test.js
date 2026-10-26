import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
test('REVIEW.md names the key collision', () => {
  assert.ok(existsSync('REVIEW.md'), 'REVIEW.md is missing');
  const t = readFileSync('REVIEW.md', 'utf8');
  assert.match(t, /cache\.js:\d+/);
  assert.match(t, /collision|ambiguous|separator|concatenat|same key/i);
});
test('cache.js was not edited', () => assert.match(readFileSync('cache.js', 'utf8'), /const key = a \+ b;/));
