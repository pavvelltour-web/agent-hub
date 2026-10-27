import type { AgentId } from '../core/types.ts';

/** One normalized event, whatever the agent. The UI, the ledger and the handoff builder only see these. */
export type HubEvent =
  | { kind: 'session'; nativeId: string; model?: string }
  | { kind: 'user'; text: string }                                                       // history only: what the person wrote (a live run shows its own prompt)
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; tokens?: number }
  | { kind: 'partial'; text: string }                                                    // live text delta: shown, never persisted (the final `text` is)
  | { kind: 'tool'; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; summary: string; body: string; lines: number; truncated: boolean; isError?: boolean }
  | { kind: 'diff'; path: string; added: number; removed: number; hunks: string }
  | { kind: 'todo'; items: { text: string; state: 'pending' | 'active' | 'done' }[] }
  | { kind: 'usage'; uncachedIn: number; cachedIn: number; out: number; reasoning?: number; costUsd?: number; ms?: number }
  | { kind: 'context'; tokens: number; newIn?: number; cachedIn?: number; out?: number; mid?: string }   // size of the prompt of ONE model call (what the next call must carry), plus the split of that call; watched by the runner, never sent to the panel (it stores a `turn` row from it, ADR-024)
  | { kind: 'turn'; newIn: number; cachedIn: number; out: number; reasoning?: number; context: number; mid?: string }   // STORED form of `context` (Phase 7 trace and gauge); never emitted by an adapter
  | { kind: 'unknown'; type: string }
  | { kind: 'limit'; reached: boolean; message: string; resetsAt?: string; usedPercent?: number }
  | { kind: 'warn'; message: string }
  | { kind: 'error'; message: string; needsLogin?: boolean }
  | { kind: 'done'; ok: boolean };

/** Most characters one event body/text/string may hold, applied AFTER redaction. What is stored and rendered never exceeds it per field. */
export const MAX_BODY = 64_000;

export type Permission = 'plan' | 'edit' | 'full';

export interface RunRequest {
  prompt: string; cwd: string; model?: string; effort?: string; resumeId?: string; permission?: Permission;
  lean?: string[];               // extra flags that keep the run light (see run/lean.ts)
  extraArgs?: string[];          // INTERNAL only (review gate: structured-output flags); appended to the CLI args, never settable from the HTTP API
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
