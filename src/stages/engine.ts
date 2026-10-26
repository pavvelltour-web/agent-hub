import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../core/registry.ts';
import { safeJoin } from '../lib/paths.ts';

export interface Stage { id: number; key: string; title: string; outputs: string[]; skills: string[]; taskClass: string; help: string; you: string; agent: string; starter: string }
export interface StageStatus extends Stage { present: string[]; missing: string[]; approvedAt: string | null; state: 'approved' | 'ready' | 'blocked' | 'current' }

export const loadStages = (): Stage[] => JSON.parse(readFileSync(join(REPO_ROOT, 'stages', 'stages.json'), 'utf8')) as Stage[];

const approvalsPath = (root: string): string => join(root, '.hub', 'stages.json');
const readApprovals = (root: string): Record<string, string> => { try { return JSON.parse(readFileSync(approvalsPath(root), 'utf8')) as Record<string, string>; } catch { return {}; } };

/**
 * Gate state per stage. `ready` = outputs exist, waiting for the user's OK. `current` = first stage that is not approved.
 * A stage can only be approved when all its outputs exist (FR-S1); approval is a user action recorded in the audit log.
 */
export function stageStatus(root: string): StageStatus[] {
  const appr = readApprovals(root);
  let currentSet = false;
  return loadStages().map((s) => {
    const present = s.outputs.filter((o) => existsSync(safeJoin(root, o)));
    const missing = s.outputs.filter((o) => !present.includes(o));
    const approvedAt = appr[String(s.id)] ?? null;
    let state: StageStatus['state'] = approvedAt ? 'approved' : missing.length ? 'blocked' : 'ready';
    if (!approvedAt && !currentSet) { currentSet = true; state = missing.length ? 'current' : 'ready'; }
    return { ...s, present, missing, approvedAt, state };
  });
}

export function approveStage(root: string, id: number, now = new Date()): StageStatus {
  const st = stageStatus(root).find((s) => s.id === id);
  if (!st) throw new Error(`no such stage: ${id}`);
  if (st.missing.length) throw new Error(`stage ${id} cannot be approved: missing ${st.missing.join(', ')}`);
  const earlier = stageStatus(root).filter((s) => s.id < id && !s.approvedAt);
  if (earlier.length) throw new Error(`approve stage ${earlier[0]?.id} first`);
  mkdirSync(join(root, '.hub'), { recursive: true });
  writeFileSync(approvalsPath(root), JSON.stringify({ ...readApprovals(root), [String(id)]: now.toISOString() }, null, 1));
  appendFileSync(join(root, '.hub', 'audit.jsonl'), JSON.stringify({ ts: now.toISOString(), action: 'approve-stage', stage: id }) + '\n');
  return stageStatus(root).find((s) => s.id === id) as StageStatus;
}
