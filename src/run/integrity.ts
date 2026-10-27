import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadUserConfig, saveUserConfig } from '../core/registry.ts';

/**
 * Tamper evidence for the hub's own settings files (ADR-025, ADR-026). An unattended agent runs as the same user and CAN write `<hub home>`: that is not a hard boundary.
 * What this does: the hub keeps a hash of what it last wrote into `autouse.json`, `guardrails.json` (the acknowledgements) and the `guardrails` part of `config.json`
 * (`<dir>/integrity.json`). A file that no longer matches was changed by something other than the hub: it is NOT read (the automatic start reads as OFF; the protection reads as
 * ON with the defaults; forged acknowledgements clear nothing), the change is written once to the audit log and to `tamper.json`, and the panel says so until the user resets.
 * The seal file itself is writable by the same agent: this catches a careless or naive change, not a determined one.
 */
const SEALS = 'integrity.json', MARK = 'tamper.json', MAX = 200_000;
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const readJson = (path: string): Record<string, unknown> => { try { if (statSync(path).size > MAX) return {}; const j = JSON.parse(readFileSync(path, 'utf8')) as unknown; return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}; } catch { return {}; } };
const writeAtomic = (path: string, text: string): void => { const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; writeFileSync(tmp, text, 'utf8'); renameSync(tmp, path); };

export const hashFile = (path: string): string => { try { return sha(readFileSync(path)); } catch { return 'absent'; } };
const sealOf = (dir: string, key: string): string | undefined => { const s = readJson(join(dir, SEALS))['seals']; const v = s && typeof s === 'object' ? (s as Record<string, unknown>)[key] : undefined; return typeof v === 'string' ? v : undefined; };
export function seal(dir: string, key: string, hash: string): void {
  const all = readJson(join(dir, SEALS)), seals = all['seals'] && typeof all['seals'] === 'object' ? { ...(all['seals'] as Record<string, unknown>) } : {};
  seals[key] = hash;
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, SEALS), JSON.stringify({ seals }));
}
/** The hub just wrote `<dir>/<name>`: remember what it looks like now. */
export const sealFile = (dir: string, name: string): void => seal(dir, name, hashFile(join(dir, name)));
/**
 * `ok`: the file is as the hub left it, or it is gone (an empty file is the safe direction). `changed`: it differs from the seal, or it exists and the hub never sealed it (fail closed:
 * a file nobody wrote through the hub cannot be told from a forged one).
 */
export function fileState(dir: string, name: string): 'ok' | 'changed' {
  const cur = hashFile(join(dir, name)), s = sealOf(dir, name);
  if (cur === 'absent') return 'ok';
  return s !== undefined && s === cur ? 'ok' : 'changed';
}

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const GKEY = 'config.json guardrails';
/** The route that saved the user's caps seals what it saved. */
export const sealGuardrailsConfig = (dir: string): void => seal(dir, GKEY, sha(JSON.stringify(canon(loadUserConfig().guardrails ?? null))));
/** Is this `guardrails` value the one the hub's route saved? Nothing at all is fine (the defaults apply). */
export const guardrailsConfigTrusted = (dir: string, value: unknown): boolean => value === undefined || sealOf(dir, GKEY) === sha(JSON.stringify(canon(value)));
export const GUARDRAILS_FILE = GKEY;

// ---------- the record of what was found ----------
const auditName = (file: string): string => (file.startsWith('autouse') ? 'autouse-audit.jsonl' : 'guardrails-audit.jsonl');
/** Written once per file until the user resets: an audit line and an entry in `tamper.json`. */
export function recordTamper(dir: string, file: string): void {
  try {
    const m = readJson(join(dir, MARK)), files = m['files'] && typeof m['files'] === 'object' ? { ...(m['files'] as Record<string, unknown>) } : {};
    if (typeof files[file] === 'string') return;
    files[file] = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, MARK), JSON.stringify({ files }));
    appendFileSync(join(dir, auditName(file)), JSON.stringify({ ts: files[file], action: 'tamper-detected', file }) + '\n');
  } catch { /* best effort: the file is ignored either way */ }
}
export const hasTamper = (dir: string, file: string): boolean => typeof (readJson(join(dir, MARK))['files'] as Record<string, unknown> | undefined)?.[file] === 'string';
export function tamperList(dirs: string[]): { file: string; at: string; dir: string }[] {
  const out: { file: string; at: string; dir: string }[] = [];
  for (const dir of new Set(dirs)) { const f = readJson(join(dir, MARK))['files']; if (f && typeof f === 'object') for (const [file, at] of Object.entries(f as Record<string, unknown>)) if (typeof at === 'string') out.push({ file: file.slice(0, 80), at: at.slice(0, 40), dir }); }
  return out;
}
/**
 * The user looked: everything the tampered files held is dropped (the automatic start is OFF, no acknowledgement stands, the caps are the defaults) and sealed as such.
 * The user then switches things on again by hand. `hubHome` holds `config.json`.
 */
export function resetTamper(dirs: string[], hubHome: string): void {
  for (const dir of new Set(dirs)) {
    for (const f of ['autouse.json', 'guardrails.json']) { try { rmSync(join(dir, f), { force: true }); } catch { /* gone */ } seal(dir, f, 'absent'); }
    try { rmSync(join(dir, MARK), { force: true }); } catch { /* gone */ }
    try { appendFileSync(join(dir, 'guardrails-audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action: 'tamper-reset' }) + '\n'); } catch { /* best effort */ }
  }
  const cfg = loadUserConfig();
  if (cfg.guardrails !== undefined) { const { guardrails: _g, ...rest } = cfg; saveUserConfig(rest); }
  sealGuardrailsConfig(hubHome);
  try { rmSync(join(hubHome, MARK), { force: true }); } catch { /* gone */ }
}
