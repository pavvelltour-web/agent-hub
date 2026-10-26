import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueBy } from './unique.js';
const rows = () => [{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }];
test('keeps the first item of each key, in the original order', () => assert.deepEqual(uniqueBy(rows(), (x) => x.id), [{ id: 1, v: 'a' }, { id: 2, v: 'c' }]));
test('does not change the input array', () => { const r = rows(); uniqueBy(r, (x) => x.id); assert.deepEqual(r, rows()); });
