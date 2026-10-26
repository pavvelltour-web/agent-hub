import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stats } from './legacy.js';
test('no var left in legacy.js', () => assert.doesNotMatch(readFileSync('legacy.js', 'utf8'), /\bvar\b/));
test('behaviour is unchanged', () => assert.deepEqual(stats([1, 2, 6]), { total: 9, max: 6, mean: 3 }));
test('empty input', () => assert.deepEqual(stats([]), { total: 0, max: -Infinity, mean: 0 }));
