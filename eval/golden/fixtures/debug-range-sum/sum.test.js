import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from './sum.js';
test('sumTo(4) is 10', () => assert.equal(sumTo(4), 10));
test('sumTo(1) is 1', () => assert.equal(sumTo(1), 1));
test('sumTo(0) is 0', () => assert.equal(sumTo(0), 0));
