import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

const fake = mkdtempSync(join(tmpdir(), 'hub-tplpath-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub'); process.env['APPDATA'] = join(fake, 'AppData', 'Roaming');
const { planNewProject, applyNewProject, planDigest } = await import('./templates.ts');
process.on('exit', () => { try { rmSync(fake, { recursive: true, force: true }); } catch { /* best effort */ } });

const win = process.platform === 'win32';
/** The 8.3 short form of an existing path (cmd's %~s), or null when the volume has none. */
function shortName(p: string): string | null {
  if (!win) return null;
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const s = (r.stdout ?? '').trim();
  return r.status === 0 && s && s.toLowerCase() !== p.toLowerCase() ? s : null;
}

test('alias spellings of a forbidden folder are refused: 8.3 short names, \\\\.\\ device paths, \\\\?\\ and UNC forms', { skip: !win }, () => {
  const forbidden = [join(fake, '.claude'), join(fake, '.codex'), join(fake, '.agents'), join(fake, 'AppData', 'Roaming', 'Claude'), join(fake, '.agent-hub')];
  for (const f of forbidden) mkdirSync(f, { recursive: true });
  try {
    let shorts = 0;
    for (const f of forbidden) {
      const s = shortName(f);
      if (s) { shorts++; assert.throws(() => planNewProject('web-saas', join(s, 'x')), /agent|hub/i, `short name ${s}`); }
      // the same folder spelled with other separators and case
      assert.throws(() => planNewProject('web-saas', join(f.toUpperCase().replace(/\\/g, '/'), 'x')), /agent|hub/i, 'case and slashes');
    }
    if (!shorts) console.log('# note: this volume has no 8.3 short names; the short-name assertions were not exercised');
    const drive = parse(fake).root.slice(0, 2), rest = fake.slice(2);
    for (const alias of [`\\\\.\\${fake}\\.claude\\x`, `\\\\?\\${fake}\\.claude\\x`, `\\\\localhost\\${drive[0]}$${rest}\\.claude\\x`, `\\\\?\\UNC\\localhost\\${drive[0]}$${rest}\\.claude\\x`, `//localhost/${drive[0]}$${rest.replace(/\\/g, '/')}/.claude/x`, '\\\\server\\share\\proj'])
      assert.throws(() => planNewProject('web-saas', alias), /network|device|UNC/i, alias);
    // the project folder itself spelled through a short name lands on the canonical long path
    const long = join(fake, 'a rather long folder name'); mkdirSync(long);
    const ls = shortName(long);
    if (ls) assert.equal(planNewProject('web-saas', join(ls, 'sub')).root.toLowerCase(), join(long, 'sub').toLowerCase(), 'plan.root is the canonical path');
  } finally { for (const f of forbidden) rmSync(f, { recursive: true, force: true }); rmSync(join(fake, 'a rather long folder name'), { recursive: true, force: true }); }
});

test('device and UNC spellings are refused on every platform (they are a string check, not a lookup)', () => {
  for (const p of ['\\\\.\\C:\\x\\y', '\\\\?\\C:\\x\\y', '\\\\?\\UNC\\h\\s\\p', '\\\\host\\share\\p', '//host/share/p'])
    assert.throws(() => planNewProject('web-saas', p), /network|device|UNC/i, p);
});

test('a link that appears in the path after the plan is noticed at apply: nothing is written through it', () => {
  const base = mkdtempSync(join(tmpdir(), 'hub-tplj-'));
  const store = join(fake, '.claude'); mkdirSync(store, { recursive: true });
  try {
    const target = join(base, 'ln', 'new');
    const plan = planNewProject('automation', target);                       // `ln` does not exist yet: the plan is fine
    let linked = true; try { symlinkSync(store, join(base, 'ln'), 'junction'); } catch { linked = false; }
    if (!linked) return;
    assert.throws(() => applyNewProject(plan, { approved: true }), /agent|hub|changed|link/i);
    assert.ok(!existsSync(join(store, 'new')) && !existsSync(join(store, 'new', 'AGENTS.md')), 'nothing landed in the forbidden folder');
    // a link to an ordinary folder is refused too: the path is no longer the one that was planned
    rmSync(join(base, 'ln'), { recursive: true, force: true });
    const elsewhere = join(base, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(base, 'ln'), 'junction');
    assert.throws(() => applyNewProject(plan, { approved: true }), /changed|link/i);
    assert.ok(!existsSync(join(elsewhere, 'new')));
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); }
});

test('planDigest covers the files, links, steps and verify of the plan: any difference changes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tpld-'));
  try {
    const a = planNewProject('web-saas', join(dir, 'p')), b = planNewProject('web-saas', join(dir, 'p')), c = planNewProject('automation', join(dir, 'p'));
    assert.equal(planDigest(a), planDigest(b)); assert.notEqual(planDigest(a), planDigest(c));
    assert.notEqual(planDigest(a), planDigest({ ...a, steps: [] }));
    assert.notEqual(planDigest(a), planDigest({ ...a, changes: a.changes.map((x, i) => (i ? x : { ...x, after: x.after + ' ' })) }));
    assert.notEqual(planDigest(a), planDigest({ ...a, verify: ['node', '-e', '1'] }));
    writeFileSync(join(dir, 'unused'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
