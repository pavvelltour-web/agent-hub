import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.js';
test('lowercases and joins words with dashes', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('collapses runs of other characters and trims dashes', () => assert.equal(slugify('  A -- b__c!  '), 'a-b-c'));
test('keeps Cyrillic letters and digits', () => assert.equal(slugify('Привет, мир 2'), 'привет-мир-2'));
test('empty input gives an empty string', () => assert.equal(slugify('!!!'), ''));
