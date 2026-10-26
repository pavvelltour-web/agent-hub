// Security gate (docs/SECURITY.md §2–3). Run: `npm run security` or `hub security [--docker]`.
// Checks: dependency audit, secret patterns in the repo, risky code patterns, package contents. Exit code 1 on any failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'graphify-out', 'dist', 'refs-private', 'captures', '.hub']);
const SKIP_EXT = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.webp', '.sqlite', '.zip']);
const results = [];
const add = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };

function* files(dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (!SKIP_EXT.has(n.slice(n.lastIndexOf('.')).toLowerCase()) && st.size < 2_000_000) yield p;
  }
}
const all = [...files(root)];

// 1. Dependencies
const pn = spawnSync('pnpm', ['audit', '--audit-level', 'high'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
add('dependency audit (pnpm audit, high+)', pn.status === 0, pn.status === 0 ? 'no known high/critical vulnerabilities' : (pn.stdout || pn.stderr).split('\n').slice(0, 3).join(' | '));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
add('zero runtime dependencies', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, `dev only: ${Object.keys(pkg.devDependencies ?? {}).join(', ')}`);

// 2. Secrets: the app's own redaction rules, applied to every text file of the repo
const { redact } = await import(pathToFileURL(join(root, 'src', 'lib', 'redact.ts')).href);
const hits = [];
for (const f of all) {
  if (/\.test\.ts$|security\.mjs$|redact\.ts$|[\\/]lib[\\/]paths\.ts$/.test(f)) continue;   // fake-secret fixtures; paths.ts holds a secret-FILENAME pattern, not a secret
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => { if (line.length < 4000 && redact(line) !== line) hits.push(`${relative(root, f)}:${i + 1}`); });
}
add('no secret-looking strings in the repo', hits.length === 0, hits.slice(0, 5).join(', '));

// 3. Risky patterns (rule → regex over src/ and bin/)
const RULES = [
  ['no shell spawning', /shell:\s*true/], ['no exec()/execSync() from child_process', /import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*['"]node:child_process['"]|\bexecSync\s*\(/], ['no eval / new Function', /\beval\s*\(|new Function\s*\(/],
  ['no Math.random for secrets', /Math\.random\(\)/], ['no disabled TLS checks', /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/],
  ['no bind on all interfaces', /listen\([^)]*['"]0\.0\.0\.0['"]/], ['no CORS wildcard', /access-control-allow-origin['"]?\s*[:,]\s*['"]\*/i],
];
const code = all.filter((f) => /[\\/](src|bin)[\\/]/.test(f) && /\.(ts|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f));
for (const [name, re] of RULES) {
  const bad = code.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
  add(name, bad.length === 0, bad.join(', '));
}
// Web: no innerHTML with data, no inline handlers
const web = all.filter((f) => /[\\/]web[\\/]/.test(f) && /\.(js|html)$/.test(f));
const inner = web.filter((f) => /\.innerHTML\s*=/.test(readFileSync(f, 'utf8')) && !/ui\.js$/.test(f)).map((f) => relative(root, f));
add('web: innerHTML only for constant icons (ui.js)', inner.length === 0, inner.join(', '));
const inline = web.filter((f) => /\son(?:click|load|error)=/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
add('web: no inline event handlers (CSP)', inline.length === 0, inline.join(', '));
add('web: no external hosts', !web.some((f) => /https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)[\w.-]+/.test(readFileSync(f, 'utf8').replace(/data:image[^"']*/g, ''))), 'fonts and scripts are local');

// 4. Package contents
const pk = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
try {
  const list = JSON.parse(pk.stdout)[0].files.map((f) => f.path);
  const bad = list.filter((p) => /(^|\/)(\.env|auth\.json|\.credentials|refs-private|captures|\.hub)(\/|$)/.test(p));
  add('npm package has no private files', bad.length === 0, bad.join(', ') || `${list.length} files`);
} catch { add('npm package contents', false, 'npm pack --dry-run failed'); }

// 5. Optional heavy scanners via Docker (no local install needed)
if (process.argv.includes('--docker')) {
  const d = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (d.status !== 0) add('docker scanners', false, 'docker daemon is not running');
  else {
    const g = spawnSync('docker', ['run', '--rm', '-v', `${root}:/repo:ro`, 'zricethezav/gitleaks:latest', 'detect', '--no-git', '-s', '/repo', '--exit-code', '1'], { encoding: 'utf8' });
    add('gitleaks (docker)', g.status === 0, g.status === 0 ? 'clean' : (g.stdout + g.stderr).slice(-300));
    const s = spawnSync('docker', ['run', '--rm', '-v', `${root}:/src:ro`, 'semgrep/semgrep:latest', 'semgrep', '--config', 'p/javascript', '--config', 'p/typescript', '--error', '--quiet', '/src/src', '/src/web'], { encoding: 'utf8' });
    add('semgrep (docker)', s.status === 0, s.status === 0 ? 'no findings' : (s.stdout + s.stderr).slice(-400));
  }
} else console.log('· gitleaks/semgrep/trivy not run (add --docker; needs a running Docker daemon)');

const dir = join(root, '.hub', 'security');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `report-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
