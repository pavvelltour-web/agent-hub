import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web', 'js', 'welcome-flag.js');
const load = async (tag: string) => await import(pathToFileURL(file).href + '?' + tag) as { welcomeDone: () => boolean; markWelcomeDone: () => void };
const g = globalThis as { localStorage?: unknown };

test('first-run flag: stored when storage works; when storage throws (private mode, blocked site data) it is kept in memory for the session, so "skip all" cannot loop back to /welcome', async () => {
  const mem = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const a = await load('a');
  assert.equal(a.welcomeDone(), false); a.markWelcomeDone(); assert.equal(a.welcomeDone(), true); assert.equal(mem.get('hub.welcomeDone'), '1');
  assert.equal((await load('a2')).welcomeDone(), true, 'a new page load sees the stored flag');
  g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const b = await load('b');
  assert.equal(b.welcomeDone(), false);
  assert.doesNotThrow(() => b.markWelcomeDone());
  assert.equal(b.welcomeDone(), true, 'the in-memory fallback answers true although storage throws');
  delete g.localStorage;
  const c = await load('c');
  assert.equal(c.welcomeDone(), false); c.markWelcomeDone(); assert.equal(c.welcomeDone(), true, 'no storage object at all');
});
