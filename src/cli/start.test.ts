import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'install.ps1');
const CHECKER = join(import.meta.dirname, 'readonly-check.ps1.txt');
const dirs: string[] = [];
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SYS = process.env['SystemRoot'] ?? 'C:\\Windows';
const PS = join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const canPs = process.platform === 'win32' && existsSync(PS);

test('install.ps1 is read-only by construction (denylist): ASCII only, no download, install, write, policy, PATH or registry verbs', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text), 'ASCII only: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/'[^'\n]*'|"[^"\n]*"/g, '""');   // strings and comments hold prose, not verbs
  for (const word of ['Invoke-WebRequest', 'Invoke-RestMethod', 'iwr', 'irm', 'curl', 'wget', 'Start-BitsTransfer', 'Set-ExecutionPolicy', 'setx', 'SetEnvironmentVariable', 'Set-ItemProperty', 'New-ItemProperty', 'Remove-Item', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Copy-Item', 'Move-Item', 'Start-Process', 'Invoke-Expression', 'iex', 'winget', 'choco', 'npm', 'Install-', 'Expand-Archive'])
    assert.ok(!new RegExp(`(^|[^\\w-])${word}([^\\w]|$)`, 'i').test(code), `no ${word}`);
  assert.ok(!/>\s*\S/.test(code.replace(/-gt|-lt|2>\$null/g, '')), 'no redirection to a file');
});

/** The AST checker: every file is parsed by PowerShell itself and judged against an allowlist. Returns "OK" or "REJECT: ..." per file. */
function check(files: Record<string, string>): Record<string, string> {
  const d = tmp('hub-ps-chk-'), paths: string[] = [];
  for (const [name, text] of Object.entries(files)) { const p = join(d, name); writeFileSync(p, text); paths.push(p); }
  const checker = join(d, 'check.ps1'); cpSync(CHECKER, checker);   // -File wants a .ps1 name; the source copy is .txt so it is never mistaken for a script of the package
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker, ...paths], { encoding: 'utf8', windowsHide: true });
  const out: Record<string, string> = {};
  for (const line of r.stdout.split(/\r?\n/)) { const i = line.indexOf('\t'); if (i > 0) out[line.slice(line.lastIndexOf('\\', i) + 1, i)] = line.slice(i + 1); }
  assert.equal(Object.keys(out).length, Object.keys(files).length, r.stdout + r.stderr);
  return out;
}

test('install.ps1 passes the AST allowlist; eleven known bypasses of the old denylist and more are all REJECTED', { skip: !canPs }, () => {
  const ok = check({ 'install.ps1': readFileSync(SCRIPT, 'utf8') });
  assert.equal(ok['install.ps1'], 'OK', 'the real script is accepted');
  const bypass: Record<string, string> = {
    'string-subexpr.ps1': 'Write-Host "$(Remove-Item x)"',
    'alias-sc.ps1': "sc out.txt 'hi'",
    'alias-ni.ps1': 'ni f.txt',
    'alias-rm.ps1': 'rm f.txt',
    'webclient.ps1': "(New-Object Net.WebClient).DownloadFile('http://x','y')",
    'io-file.ps1': "[IO.File]::WriteAllText('x','y')",
    'iex-concat.ps1': "& ('i'+'ex') 'echo hi'",
    'tee.ps1': "'x' | Tee-Object -FilePath out.txt",
    'cmd-c.ps1': 'cmd /c echo hi',
    'encoded.ps1': 'powershell -EncodedCommand AAAA',
    'reg-add.ps1': 'reg add HKCU\\Software\\X /v a /d b',
    'dot-source.ps1': '. .\\other.ps1',
    'redirect.ps1': "Write-Host 'x' > out.txt",
    'scriptblock.ps1': '& { rm x }',
    'get-command-iex.ps1': "$x = Get-Command iex\n& $x 'echo hi'",
    'probe-iex.ps1': "function Probe([string]$name) { $c = Get-Command $name | Select-Object -First 1; return $c.Source }\n$x = Probe 'iex'\n& $x 'echo'",
    'static-env.ps1': "[Environment]::SetEnvironmentVariable('A','b','User')",
    'member-call.ps1': "$a = 'x'\n$a.Replace('x','y')",
    'iex-direct.ps1': "Invoke-Expression 'echo hi'",
    'iex-alias.ps1': "'echo hi' | iex",
    'parse-error.ps1': 'if (',
  };
  const got = check(bypass);
  for (const name of Object.keys(bypass)) assert.match(got[name] ?? 'missing', /^REJECT: /, `${name} must be rejected (got: ${got[name]})`);
});

/** Runs a script with a PATH that holds only fake tools, so the machine's own Node and Git do not matter. An answer of `null` is a tool that prints nothing. */
function run(tools: Record<string, string | null>, script = SCRIPT): { code: number | null; out: string; bin: string[] } {
  const bin = tmp('hub-ps-bin-');
  for (const [name, answer] of Object.entries(tools)) writeFileSync(join(bin, `${name}.cmd`), answer === null ? '@echo off\r\n' : `@echo off\r\necho ${answer}\r\n`);
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true, env: { SystemRoot: SYS, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: process.env['ComSpec'] ?? join(SYS, 'System32', 'cmd.exe'), PATH: `${bin};${join(SYS, 'System32')}` } });
  return { code: r.status, out: r.stdout + r.stderr, bin: readdirSync(bin) };
}

test('install.ps1 on Windows: too-old or missing Node and missing Git exit 1 with the fix; a good set prints the next commands; nothing is written', { skip: !canPs }, () => {
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

test('S4 install.ps1: a Node that prints nothing is a plain message (no PowerShell error text); a nightly version is accepted', { skip: !canPs }, () => {
  const empty = run({ node: null, git: 'g' });
  assert.equal(empty.code, 1); assert.match(empty.out, /\[\?\] Node\.js printed nothing/);
  assert.ok(!/InvokeMethodOnNull|You cannot call a method|Exception|At line:/i.test(empty.out), empty.out);
  const nightly = run({ node: 'v25.0.0-nightly20251020abcdef', git: 'g' });
  assert.equal(nightly.code, 0, nightly.out); assert.match(nightly.out, /\[ok\] Node\.js v25\.0\.0-nightly/);
  const nightlyOld = run({ node: 'v23.9.0-nightly2025', git: 'g' });
  assert.equal(nightlyOld.code, 1); assert.match(nightlyOld.out, /too old/);
});

test('S4 install.ps1: the printed cd is a single-quoted literal that survives $, a quote and spaces; a folder with % or a typographic quote gets no cd line', { skip: !canPs }, () => {
  const place = (name: string): string => { const base = tmp('hub-ps-root-'), root = join(base, name); mkdirSync(join(root, 'scripts'), { recursive: true }); cpSync(SCRIPT, join(root, 'scripts', 'install.ps1')); return root; };
  const root = place("a $b 'c' d");
  const r = run({ node: 'v24.1.0', git: 'g' }, join(root, 'scripts', 'install.ps1'));
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`cd '${root.replace(/'/g, "''")}'`), `the cd line must be the quoted literal:\n${r.out}`);
  assert.ok(!r.out.includes('cd "'), 'no double-quoted path');
  // the line really changes into that folder in PowerShell
  const line = (r.out.split(/\r?\n/).find((l) => l.trim().startsWith('cd ')) as string).trim();
  const cd = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `${line}; (Get-Location).Path`], { encoding: 'utf8', windowsHide: true });
  assert.equal(cd.stdout.trim(), root);
  const pct = place('a%b');
  const p = run({ node: 'v24.1.0', git: 'g' }, join(pct, 'scripts', 'install.ps1'));
  assert.equal(p.code, 0, p.out); assert.ok(!/^\s*cd /m.test(p.out), 'no cd line'); assert.match(p.out, /special characters/);
  const smart = place('a\u2019b');
  const s = run({ node: 'v24.1.0', git: 'g' }, join(smart, 'scripts', 'install.ps1'));
  assert.equal(s.code, 0, s.out); assert.ok(!/^\s*cd /m.test(s.out), 'no cd line'); assert.match(s.out, /special characters/);
});

test('bin/hub.js: an installed copy without dist/ says so instead of crashing; the source checkout still starts', () => {
  const pkg = tmp('hub-bin-'), nm = join(pkg, 'node_modules', 'agent-hub', 'bin');
  mkdirSync(nm, { recursive: true }); cpSync(join(ROOT, 'bin', 'hub.js'), join(nm, 'hub.js'));
  const r = spawnSync(process.execPath, [join(nm, 'hub.js'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1); assert.match(r.stderr, /no compiled dist\/.*node_modules/);
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin', 'hub.js'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /agent-hub/);
});
