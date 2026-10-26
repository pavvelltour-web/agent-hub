import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from './chunk.js';
test('splits into groups of n, last one may be shorter', () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
test('does not change the input', () => { const a = [1, 2, 3]; chunk(a, 2); assert.deepEqual(a, [1, 2, 3]); });
test('empty array gives no groups', () => assert.deepEqual(chunk([], 3), []));
test('n below 1 throws RangeError', () => assert.throws(() => chunk([1], 0), RangeError));
