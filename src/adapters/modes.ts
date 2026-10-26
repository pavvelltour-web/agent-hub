import type { Permission } from './types.ts';

const CLAUDE = { plan: 'plan', edit: 'auto', full: 'bypassPermissions' } as const;
const SANDBOX = { plan: 'read-only', edit: 'workspace-write', full: 'danger-full-access' } as const;

/** What `auto` approves headless is unverified until `hub doctor --modes` measures it (Task 1.2). */
export const claudeModeArgs = (p: Permission): string[] => ['--permission-mode', CLAUDE[p]];

/** `codex exec resume` takes no `-s`: the same sandbox goes in as a config override, or a resumed chat would silently lose its mode. */
export const codexModeArgs = (p: Permission, resume: boolean): string[] => (resume ? ['-c', `sandbox_mode="${SANDBOX[p]}"`] : ['-s', SANDBOX[p]]);
