export type Kind = 'skill' | 'plugin' | 'mcp' | 'agent' | 'command' | 'hook' | 'rule-pack';
export type Compat = 'native' | 'adapted' | 'unsupported' | 'unknown';
export type AgentId = 'claude' | 'codex';

export interface McpSpec { command?: string; args?: string[]; url?: string; env?: string[] }

export interface RegistryEntry {
  id: string;                       // e.g. skill/ponytail
  kind: Kind;
  title: string;
  description: string;
  source: { type: 'local' | 'github' | 'npm' | 'aitmpl'; repo?: string; ref?: string; path?: string };
  installCommand?: string;          // what the user would run by hand; shown, never run silently
  license?: string;
  tags: string[];
  stages: number[];                 // lifecycle stages where the entry helps (1..8)
  projectTypes: string[];           // '*' = any
  compat: Record<AgentId, Compat>;
  tokenCost: number;                // tokens the description adds to every turn
  risk: { executesCode: boolean; network: boolean; writesOutside: boolean };
  sourceVerified: boolean;          // false = install details come from memory, not checked
  mcp?: McpSpec;
  /** Where the agent can see it WITHOUT this project's links: user = loaded globally, project = this repo, hub = only in the hub library (costs nothing until linked). */
  downloads?: number;               // popularity in the outside catalog it came from
  scan?: string;                    // severity the catalog's own scanner gave it, when it has one
  scope?: 'user' | 'project' | 'hub';
  visibleTo?: AgentId[];
  /** Agents that load it in EVERY project (user-level folders). These pay its description on every turn. */
  globalVisibleTo?: AgentId[];
}

/** One concrete write the hub wants to make. Nothing is written until a plan is approved. */
export interface FileChange {
  path: string;                     // absolute
  action: 'create' | 'update' | 'link' | 'unlink';
  before: string | null;            // text before (null = did not exist)
  after: string;                    // text after, or link target for `link` (empty for `unlink`)
  note?: string;
}
export interface Plan { root: string; changes: FileChange[]; notes: string[] }

export interface HubConfig {
  version: 1;
  project: { slug: string; type: string };
  agents: { id: AgentId; enabled: boolean }[];
  rules: { source: 'AGENTS.md'; claudePointer: boolean };
  limits: { handoffThresholdPercent: number; autoHandoff: boolean };
  /** Review gate settings. Optional; unknown keys in hub.json are tolerated. `checks` are argv lists; `humanPaths` are globs that always need a human approval. */
  review?: { effort?: string; checks?: string[][]; humanPaths?: string[] };
  /** Verify command of the verify-and-escalate cascade (an argv list, e.g. ["npm", "test"]). Read from the PROJECT ROOT, never the branch; it runs only after the same digest-pinned approval as `review.checks` (ADR-017). hub.json can come from a clone: untrusted. */
  verify?: string[];
}

export interface LockEntry {
  id: string;
  kind: Kind;
  source: RegistryEntry['source'];
  hash: string | null;
  license: string | null;
  tokenCost: number;
  targets: Record<AgentId, { status: Compat; installedTo?: string; changes?: string[] }>;
  approvedAt: string;
}
export interface Lock { version: 1; generatedAt: string; entries: LockEntry[] }
