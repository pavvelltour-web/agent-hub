import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'install.ps1');
const dirs: string[] = [];
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('install.ps1 is read-only by construction: ASCII only, no download, install, write, policy, PATH or registry verbs', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text), 'ASCII only: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/'[^'\n]*'|"[^"\n]*"/g, '""');   // strings and comments hold prose, not verbs
  for (const word of ['Invoke-WebRequest', 'Invoke-RestMethod', 'iwr', 'irm', 'curl', 'wget', 'Start-BitsTransfer', 'Set-ExecutionPolicy', 'setx', 'SetEnvironmentVariable', 'Set-ItemProperty', 'New-ItemProperty', 'Remove-Item', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Copy-Item', 'Move-Item', 'Start-Process', 'Invoke-Expression', 'iex', 'winget', 'choco', 'npm', 'Install-', 'Expand-Archive'])
    assert.ok(!new RegExp(`(^|[^\w-])${word}([^\w]|$)`, 'i').test(code), `no ${word}`);
  assert.ok(!/>\s*\S/.test(code.replace(/-gt|-lt/g, '')), 'no redirection to a file');
});

const PS = join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Runs the script with a PATH that holds only fake tools, so the machine's own Node and Git do not matter. */
function run(tools: Record<string, string>): { code: number | null; out: string; bin: string[] } {
  const bin = tmp('hub-ps-bin-');
  for (const [name, answer] of Object.entries(tools)) writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho ${answer}\r\n`);
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-File', SCRIPT], { encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env['SystemRoot'] ?? 'C:\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: process.env['ComSpec'] ?? 'C:\Windows\System32\cmd.exe', PATH: `${bin};${join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')}` } });
  return { code: r.status, out: r.stdout + r.stderr, bin: readdirSync(bin) };
}

test('install.ps1 on Windows: too-old or missing Node and missing Git exit 1 with the fix; a good set prints the next commands; nothing is written', { skip: process.platform !== 'win32' || !existsSync(PS) }, () => {
  const old = run({ node: 'v22.11.0', git: 'git version 2.50.0' });
  assert.equal(old.code, 1); assert.match(old.out, /too old\] Node\.js v22\.11\.0.*24 or newer/); assert.ok(!/Ready/.test(old.out));
  const none = run({});
  assert.equal(none.code, 1); assert.match(none.out, /\[missing\] Node\.js/); assert.match(none.out, /\[missing\] Git/); assert.match(none.out, /Nothing was changed/);
  const good = run({ node: 'v24.1.0', git: 'git version 2.50.0' });
  assert.equal(good.code, 0, good.out); assert.match(good.out, /\[ok\] Node\.js v24\.1\.0/); assert.match(good.out, /node bin\/hub\.js ui/); assert.match(good.out, /\[optional\] claude CLI not found/);
  assert.deepEqual(good.bin.sort(), ['git.cmd', 'node.cmd'], 'the script left the tool folder as it was');
  const withAgent = run({ node: 'v24.1.0', git: 'g', claude: 'c' });
  assert.match(withAgent.out, /\[ok\] claude CLI found/);
  const garbage = run({ node: 'banana', git: 'g' });
  assert.equal(garbage.code, 1); assert.match(garbage.out, /not a version number/);
});

test('bin/hub.js: an installed copy without dist/ says so instead of crashing; the source checkout still starts', () => {
  const pkg = tmp('hub-bin-'), nm = join(pkg, 'node_modules', 'agent-hub', 'bin');
  mkdirSync(nm, { recursive: true }); cpSync(join(ROOT, 'bin', 'hub.js'), join(nm, 'hub.js'));
  const r = spawnSync(process.execPath, [join(nm, 'hub.js'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1); assert.match(r.stderr, /no compiled dist\/.*node_modules/);
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin', 'hub.js'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /agent-hub/);
});
