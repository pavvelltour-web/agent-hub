import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_ID } from '../econ/router.ts';
import { applyWorkMode, autopilotFix, loadWorkModes, pickModeReviewer, WorkModeError, type ModeReviewer, type WorkMode } from './workmodes.ts';

const bases: string[] = [];
test.after(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });
const proj = (): { root: string; home: string } => {
  const base = mkdtempSync(join(tmpdir(), 'hub-wmf-')); bases.push(base);
  const root = join(base, 'Проект с пробелом'); mkdirSync(root);
  const home = join(base, 'home'); mkdirSync(home);
  return { root, home };
};
const link = (dir: string, name: string): void => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`); };
const mode = (id: string): WorkMode => loadWorkModes().find((m) => m.id === id) as WorkMode;
const noLib = { library: [] as never[] };

test('S1 review: implementedBy picks the other vendor; the same one only when it is alone, and then it says so; nobody available is a clear refusal', () => {
  const m = mode('review');
  const both = { claude: true, codex: true };
  const a = pickModeReviewer(m, both, { implementedBy: 'codex' }) as ModeReviewer;
  assert.equal(a.agent, 'claude'); assert.equal(a.model, MODEL_ID.opus); assert.equal(a.warn, undefined); assert.match(a.note, /Codex wrote the change/);
  const b = pickModeReviewer(m, both, { implementedBy: 'claude' }) as ModeReviewer;
  assert.equal(b.agent, 'codex'); assert.equal(b.warn, undefined);
  const alone = pickModeReviewer(m, { claude: true, codex: false }, { implementedBy: 'claude' }) as ModeReviewer;
  assert.equal(alone.agent, 'claude'); assert.match(alone.warn as string, /not cross-vendor/); assert.match(alone.warn as string, /Claude wrote/);
  const alone2 = pickModeReviewer(m, { claude: false, codex: true }, { implementedBy: 'codex' }) as ModeReviewer;
  assert.equal(alone2.agent, 'codex'); assert.match(alone2.warn as string, /not cross-vendor/);
  const plain = pickModeReviewer(m, both) as ModeReviewer;
  assert.equal(plain.warn, undefined, 'nobody said who wrote it: nothing to warn about');
  assert.ok(!/another vendor/.test(plain.note), 'and the note does not promise another vendor');
  assert.throws(() => pickModeReviewer(m, { claude: false, codex: false }, { implementedBy: 'codex' }), /sign in to Codex or Claude/);
});

test('S3 autopilot fix command: a PowerShell single-quoted literal built with node bin/hub.js; unsafe roots get no command at all', () => {
  const cmd = (root: string): string | undefined => autopilotFix(root).command;
  assert.equal(cmd('C:\\work\\app$old'), "node bin/hub.js init 'C:\\work\\app$old' --add skill/autopilot --yes", '$ is literal inside single quotes');
  assert.equal(cmd("C:\\work\\it's"), "node bin/hub.js init 'C:\\work\\it''s' --add skill/autopilot --yes", 'a quote is doubled');
  assert.equal(cmd('C:\\Program Files (x86)\\proj'), "node bin/hub.js init 'C:\\Program Files (x86)\\proj' --add skill/autopilot --yes");
  assert.equal(cmd('C:\\a`b'), "node bin/hub.js init 'C:\\a`b' --add skill/autopilot --yes", 'a backtick is literal inside single quotes');
  assert.equal(cmd('C:\\Проект с пробелом'), "node bin/hub.js init 'C:\\Проект с пробелом' --add skill/autopilot --yes");
  for (const bad of ['C:\\%OS%\\x', 'C:\\a"b', 'C:\\a\nb', 'C:\\a\rb', 'C:\\a\u2018b', 'C:\\a\u201bb', 'C:\\a\u0007b']) {
    const f = autopilotFix(bad);
    assert.equal(f.command, undefined, JSON.stringify(bad)); assert.match(f.ru, /путь содержит символы, которые нельзя безопасно вставить: добавьте скилл вручную в окне Начало/);
  }
});

test('S3 autopilot refusal: WorkModeError carries a self-contained Russian sentence and the command separately; no double-quoted paths in the message', () => {
  const { root, home } = proj();
  let err: unknown;
  try { applyWorkMode(mode('autopilot'), { agent: 'claude', prompt: 'go', projectRoot: root }, { home, ...noLib }); } catch (e) { err = e; }
  const e = err as WorkModeError;
  assert.ok(e instanceof WorkModeError); assert.ok(e.command?.startsWith("node bin/hub.js init '") && e.command.endsWith(' --add skill/autopilot --yes'));
  assert.ok(!/командой выше|команду выше/.test(e.ru), 'the Russian half does not point at text elsewhere');
  assert.ok(!e.ru.includes(e.command as string), 'the command is not repeated in the sentence the panel shows next to it');
  assert.ok(!e.message.includes('hub init "'), 'no double-quoted path'); assert.ok(e.message.includes(e.command as string), 'the API error still carries the command');
  assert.match(e.message, /install the autopilot skill in Tools/);
  const odd = proj(); const weird = join(odd.root, 'a%b'); mkdirSync(weird);
  try { applyWorkMode(mode('autopilot'), { agent: 'claude', prompt: 'go', projectRoot: weird }, { home: odd.home, ...noLib }); assert.fail('should refuse'); }
  catch (x) { const w = x as WorkModeError; assert.ok(w instanceof WorkModeError); assert.equal(w.command, undefined); assert.match(w.message, /окне Начало/); assert.ok(!/node bin\/hub\.js/.test(w.message)); }
  const cx = (() => { try { applyWorkMode(mode('autopilot'), { agent: 'codex', prompt: 'x', projectRoot: root }, { home, ...noLib }); } catch (x) { return x; } return undefined; })();
  assert.ok(cx instanceof WorkModeError); assert.match((cx as WorkModeError).ru, /Claude/);
});

test('S3 the printed command reaches node bin/hub.js as the same arguments in PowerShell (a function stands in for node)', { skip: process.platform !== 'win32' }, () => {
  const ps = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const root of ['C:\\work\\app$old', "C:\\work\\it's", 'C:\\Program Files (x86)\\proj', 'C:\\a`b c', 'C:\\Проект с пробелом']) {
    const cmd = autopilotFix(root).command as string;
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `function node { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($args -join [char]124))) }; ${cmd}`], { encoding: 'utf8', windowsHide: true });   // base64 of UTF-8: the console code page must not matter
    assert.equal(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'), `bin/hub.js|init|${root}|--add|skill/autopilot|--yes`, root);
  }
});

test("N1 interview: grill-me counts from the user's own skills or a project link that resolves into the hub library, never from a plain project folder (a clone can bring its own)", () => {
  const { root, home } = proj();
  const req = { agent: 'claude' as const, prompt: 'idea', projectRoot: root };
  link(join(root, '.claude', 'skills'), 'grill-me');   // what an untrusted clone could ship
  assert.ok(!applyWorkMode(mode('interview'), req, { home, ...noLib, hubRoots: [] }).prompt.startsWith('/grill-me'), 'a plain project folder is not trusted');
  const hub = join(home, 'hubskills'); link(hub, 'grill-me');
  const p2 = proj(); mkdirSync(join(p2.root, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(hub, 'grill-me'), join(p2.root, '.claude', 'skills', 'grill-me'), 'junction');
  assert.ok(applyWorkMode(mode('interview'), { ...req, projectRoot: p2.root }, { home, ...noLib, hubRoots: [hub] }).prompt.startsWith('/grill-me '), 'a link into the hub library counts');
  assert.ok(!applyWorkMode(mode('interview'), { ...req, projectRoot: p2.root }, { home, ...noLib, hubRoots: [join(home, 'elsewhere')] }).prompt.startsWith('/grill-me'), 'a link into any other folder does not');
  link(join(home, '.claude', 'skills'), 'grill-me');
  assert.ok(applyWorkMode(mode('interview'), req, { home, ...noLib, hubRoots: [] }).prompt.startsWith('/grill-me '), "the user's own skills count");
});
