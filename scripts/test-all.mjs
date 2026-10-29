#!/usr/bin/env node
// Runs the whole automated suite folder by folder (one `node --test` per folder of src/), then typecheck, the security
// gate and the diagram check, and writes a report you can paste into an issue. Why per folder: the whole suite in one
// command takes over 10 minutes and was only reliable this way (docs/PIPELINES-REVIEW.md, F1).
//
//   node scripts/test-all.mjs                  everything
//   node scripts/test-all.mjs --only run,core  some folders only (no typecheck/security/diagram)
//   node scripts/test-all.mjs --out my.md      report path (default: test-report.md in the repo root)
//   node scripts/test-all.mjs --tmp DIR        scratch folder for the tests (default: a fresh folder in the OS temp dir)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, release, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
const FOLDER_TIMEOUT_MS = 20 * 60_000;
const EXTRA_TIMEOUT_MS = 10 * 60_000;

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const testFiles = (dir) => walk(dir).filter((p) => /\.test\.ts$/.test(p)).sort();

/** Names of the folders directly under `srcDir` that hold at least one `*.test.ts`. */
export function listFolders(srcDir) {
  return readdirSync(srcDir).filter((n) => statSync(join(srcDir, n)).isDirectory() && testFiles(join(srcDir, n)).length > 0).sort();
}

/** The scratch folder in the OS's own spelling, created if missing. A `D:/x` given by hand would otherwise reach the tests as it is, and some of them compare paths as strings (src/review/agents.test.ts: `startsWith(os.tmpdir())`). */
export function scratchDir(p) {
  const dir = resolve(p);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
/** Counters and failed test names from the text `node --test` printed. A run with no summary gives `null`s, never a pass. */
export function parseSummary(out) {
  const text = String(out ?? '').replace(/\r/g, '');
  const failed = [...text.matchAll(/^\s*✖ (.+?) \([\d.]+ms\)\s*$/gm)].map((m) => m[1]);
  return {
    tests: num(/^ℹ tests (\d+)/m, text), pass: num(/^ℹ pass (\d+)/m, text), fail: num(/^ℹ fail (\d+)/m, text),
    skipped: num(/^ℹ skipped (\d+)/m, text), cancelled: num(/^ℹ cancelled (\d+)/m, text),
    failed: [...new Set(failed)],
  };
}

const rowOk = (r) => r.code === 0 && r.summary.tests !== null && r.summary.fail === 0 && (r.summary.cancelled ?? 0) === 0;

export function renderReport({ rows, extras, env, startedAt }) {
  const ok = rows.every(rowOk) && extras.every((e) => e.ok);
  const sum = (k) => rows.reduce((a, r) => a + (r.summary[k] ?? 0), 0);
  const lines = [
    '# Agent Hub: automated test report', '',
    `Started: ${startedAt} · Node ${env.node} · ${env.os}${env.cpu ? ` · ${env.cpu}` : ''}`, '',
    '| Folder | Tests | Pass | Fail | Skipped | Seconds | Result |', '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.summary.tests ?? '?'} | ${r.summary.pass ?? '?'} | ${r.summary.fail ?? '?'} | ${r.summary.skipped ?? '?'} | ${r.seconds} | ${rowOk(r) ? 'PASS' : 'FAIL'} |`),
    `| **total** | **${sum('tests')}** | **${sum('pass')}** | **${sum('fail')}** | **${sum('skipped')}** | | |`, '',
  ];
  if (extras.length) lines.push('| Check | Result | Note |', '|---|---|---|', ...extras.map((e) => `| ${e.name} | ${e.ok ? 'PASS' : 'FAIL'} | ${e.note ?? ''} |`), '');
  const bad = rows.filter((r) => !rowOk(r));
  if (bad.length) {
    lines.push('## Failures', '');
    for (const r of bad) lines.push(`- **${r.name}**: exit code ${r.code}${r.summary.tests === null ? ', no summary printed (the run crashed or timed out)' : ''}${r.summary.failed.length ? `; failed: ${r.summary.failed.map((n) => `\`${n}\``).join(', ')}` : ''}${r.tail ? `\n\n  \`\`\`\n${r.tail.split('\n').map((l) => `  ${l}`).join('\n')}\n  \`\`\`` : ''}`);
    lines.push('');
  }
  lines.push(`Verdict: **${ok ? 'PASS' : 'FAIL'}**`, '');
  return lines.join('\n');
}

const run = (args, env, timeout) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const lastLines = (s, n) => String(s ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').slice(-n).join('\n');

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const all = listFolders(join(ROOT, 'src'));
  const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (only) { const bad = only.filter((f) => !all.includes(f)); if (bad.length) { console.error(`unknown folder: ${bad.join(', ')}; known: ${all.join(', ')}`); process.exit(2); } }
  const folders = only ?? all;
  const tmp = scratchDir(opt('--tmp') ?? mkdtempSync(join(tmpdir(), 'agent-hub-test-')));
  // Tests must not write inside the repository: send every temp variable outside it.
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const startedAt = new Date().toISOString();
  console.log(`scratch folder: ${tmp}\nfolders: ${folders.join(', ')}`);

  const rows = [];
  for (const name of folders) {
    const t0 = Date.now();
    const r = run([...NODE_FLAGS, '--test', ...testFiles(join(ROOT, 'src', name))], env, FOLDER_TIMEOUT_MS);
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const row = { name, code: r.status ?? (r.error ? 124 : 1), seconds: Math.round((Date.now() - t0) / 100) / 10, summary: parseSummary(out) };
    if (!rowOk(row)) row.tail = lastLines(out, 25);
    rows.push(row);
    console.log(`${rowOk(row) ? 'PASS' : 'FAIL'} ${name}: ${row.summary.pass ?? '?'}/${row.summary.tests ?? '?'} in ${row.seconds}s`);
  }

  const extras = [];
  if (!only) {
    const checks = [
      ['typecheck', [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']],
      ['security', [join('scripts', 'security.mjs')]],
      ['diagrams', [...NODE_FLAGS, join('bin', 'hub.js'), 'diagram', 'arch', '--check']],
    ];
    for (const [name, args] of checks) {
      const r = run(args, env, EXTRA_TIMEOUT_MS);
      const ok = r.status === 0;
      extras.push({ name, ok, note: ok ? '' : lastLines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, 3).replace(/\|/g, '/').replace(/\n/g, ' ') });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    }
  }

  const report = renderReport({ rows, extras, startedAt, env: { node: process.version, os: `${process.platform} ${release()}`, cpu: `${cpus().length} cpu, ${Math.round(totalmem() / 2 ** 30)} GB` } });
  const outPath = resolve(opt('--out') ?? join(ROOT, 'test-report.md'));
  writeFileSync(outPath, report);
  console.log(`\nreport: ${outPath}\n${report.split('\n').filter((l) => l.startsWith('Verdict')).join('')}`);
  process.exit(rows.every(rowOk) && extras.every((e) => e.ok) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
