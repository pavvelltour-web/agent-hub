import type { AgentId } from '../core/types.ts';

/** One normalized event, whatever the agent. The UI, the ledger and the handoff builder only see these. */
export type HubEvent =
  | { kind: 'session'; nativeId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'tool_result'; summary: string; isError?: boolean }
  | { kind: 'usage'; uncachedIn: number; cachedIn: number; out: number; reasoning?: number; costUsd?: number }
  | { kind: 'limit'; reached: boolean; message: string; resetsAt?: string; usedPercent?: number }
  | { kind: 'warn'; message: string }
  | { kind: 'error'; message: string; needsLogin?: boolean }
  | { kind: 'done'; ok: boolean };

export type Permission = 'plan' | 'edit' | 'full';

export interface RunRequest {
  prompt: string; cwd: string; model?: string; effort?: string; resumeId?: string; permission?: Permission;
  lean?: string[];               // extra flags that keep the run light (see run/lean.ts)
}

export interface AgentAdapter {
  id: AgentId;
  /** Executable + fixed leading args. Overridable so tests can point at a fake agent. */
  exe(): { cmd: string; prefix: string[] } | undefined;
  /** Args after `exe().prefix`. The prompt is NEVER an argument: it goes through stdin (no length limit, no escaping). */
  args(req: RunRequest): string[];
  parse(line: unknown): HubEvent[];
}

export const clip = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) + '…' : s);
