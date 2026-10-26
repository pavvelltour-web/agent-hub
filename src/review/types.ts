import type { Pick as ReviewerPick } from '../econ/advisor.ts';
import { sha256 } from '../lib/hash.ts';

export type { ReviewerPick };
export type Severity = 'important' | 'nit' | 'pre-existing' | 'security';
export type Answer = 'open' | 'fixed' | 'rejected' | 'intentional' | 'dismissed';
export type Effort = 'quick' | 'standard' | 'deep';
export type Lens = 'correctness' | 'edge-cases' | 'intent' | 'concurrency' | 'ui' | 'security';

export interface Finding {
  id: string; fingerprint: string; reviewId: string; round: number; severity: Severity; lens: string;
  file: string; line: number; title: string; evidence: string; classOfBug?: string;
  votes: { real: number; notReal: number }; answer: Answer; reason?: string; clearedBy?: string;
}

export type RawFinding = Pick<Finding, 'lens' | 'file' | 'line' | 'title' | 'evidence' | 'classOfBug'> & { category: 'bug' | 'risk' | 'style' | 'cleanup' | 'diagnostic' };
export type VerifiedFinding = RawFinding & { votes: Finding['votes'] };

export interface Review {
  id: string; runId: string; projectId: number; baseSha: string; headSha: string; effort: Effort; risk: 'low' | 'medium' | 'high'; round: number;
  state: 'checks' | 'hunting' | 'verifying' | 'open' | 'passed' | 'needs-human' | 'reconsider';
  humanApproval?: { sha: string; at: string };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Stable across line moves and whitespace/line-ending changes: file + line text + class of bug (title only when the class is absent). Never the line number. */
export function fingerprint(f: Pick<Finding, 'file' | 'title' | 'classOfBug'>, lineText: string): string {
  const file = f.file.replace(/\\/g, '/');
  return sha256([file, squash(lineText), squash(f.classOfBug ?? f.title)].join('\0'));
}
