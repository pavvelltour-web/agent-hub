import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything an AGENT reads is English. The panel's own text (mode titles and hints, stage titles and help, the starter kit's `why`) stays Russian: it is for the person.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CYR = /[Ѐ-ӿ]/;
const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const json = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
/** Strings of a JSON value whose key is not in `skip`, with their path. */
function strings(v: unknown, skip: Set<string>, at = ''): { at: string; s: string }[] {
  if (typeof v === 'string') return [{ at, s: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, skip, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).filter(([k]) => !skip.has(k)).flatMap(([k, x]) => strings(x, skip, `${at}.${k}`));
  return [];
}
const offenders = (file: string, only?: Set<string>, skip = new Set<string>()): string[] => {
  const p = join(ROOT, file);
  const found: string[] = [];
  if (file.endsWith('.json')) {
    const v = json(p);
    const parts = only ? strings(v, new Set()).filter((x) => only.has(x.at.replace(/\[\d+\]/g, '').split('.').filter(Boolean).pop() ?? '')) : strings(v, skip);
    for (const x of parts) if (CYR.test(x.s)) found.push(`${file}${x.at}`);
  } else if (CYR.test(readFileSync(p, 'utf8'))) found.push(file);
  return found;
};

test('files and fields an agent reads contain no Cyrillic', () => {
  const bad: string[] = [];
  for (const d of ['rules', 'templates', 'registry/entries']) for (const f of walk(join(ROOT, d))) bad.push(...offenders(rel(f), undefined, new Set()));
  for (const f of ['registry/model-priors.json', 'registry/plugin-profile.json', 'registry/prices.json']) bad.push(...offenders(f));
  bad.push(...offenders('registry/starter.json', undefined, new Set(['why', 'note'])));   // `why` and `note` explain a skill to the person in the wizard
  bad.push(...offenders('stages/stages.json', new Set(['starter'])));
  for (const f of readdirSync(join(ROOT, 'modes')).filter((n) => n.endsWith('.json'))) bad.push(...offenders(`modes/${f}`, new Set(['promptPrefix'])));
  assert.deepEqual(bad, [], `Russian text in agent-facing files: ${bad.join(', ')}`);
});

test('the person-facing Russian text is still there (this test guards the split, not a blanket ban)', () => {
  assert.ok(CYR.test(JSON.stringify(json(join(ROOT, 'modes/chat.json')))), 'mode titles and hints stay Russian');
  assert.ok(statSync(join(ROOT, 'stages/stages.json')).size > 0);
});
