import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authStatus, parseAuth } from './auth.ts';

test('auth: Claude JSON and Codex text are read as signed in / out; anything else is unknown, never guessed', () => {
  assert.deepEqual(parseAuth('claude', { status: 0, stdout: '{"loggedIn": false, "authMethod": "none"}' }), { loggedIn: false, how: '' });
  assert.deepEqual(parseAuth('claude', { status: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' }), { loggedIn: true, how: 'claude.ai' });
  assert.equal(parseAuth('claude', { status: 1, stdout: 'garbage' }).loggedIn, null);
  assert.deepEqual(parseAuth('codex', { status: 0, stdout: 'Logged in using ChatGPT\n' }), { loggedIn: true, how: 'ChatGPT' });
  assert.equal(parseAuth('codex', { status: 1, stdout: 'Not logged in' }).loggedIn, false);
  assert.equal(parseAuth('codex', { status: 0, stdout: '' }).loggedIn, null);
});

test('auth: not installed means unknown, and the status command runs with fixed arguments', () => {
  assert.equal(authStatus('claude', { installed: false }).loggedIn, null);
  let seen: string[] = [];
  authStatus('codex', { installed: true, path: 'C:/x/codex.exe' }, (_c, a) => { seen = a; return { status: 0, stdout: 'Logged in using ChatGPT' }; });
  assert.deepEqual(seen, ['login', 'status']);
});
