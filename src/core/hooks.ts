import type { Compat } from './types.ts';

/**
 * Events seen in the bundled Codex plugin manifests on the author's PC (openai-bundled): SessionStart, Stop,
 * SubagentStop, Interrupt. Anything else is `unknown`, never assumed supported.
 */
export const CODEX_KNOWN_EVENTS = new Set(['SessionStart', 'Stop', 'SubagentStop', 'Interrupt']);

export interface HookReport { event: string; command: string; matcher?: string; codex: Compat; notes: string[]; codexCommand?: string }

interface ClaudeHooks { hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]> }

/**
 * Classify the hooks of a Claude plugin (`hooks/hooks.json`) for Codex. Pure function, never writes.
 * `pluginRoot` replaces `${CLAUDE_PLUGIN_ROOT}` with the absolute path (the variable does not exist in Codex).
 */
export function classifyHooks(json: string, pluginRoot: string): HookReport[] {
  const out: HookReport[] = [];
  const cfg = JSON.parse(json) as ClaudeHooks;
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        const command = h.command ?? '';
        const notes: string[] = [];
        let status: Compat = 'native';
        if (h.type && h.type !== 'command') { status = 'unsupported'; notes.push(`hook type "${h.type}" has no Codex equivalent here`); }
        if (!CODEX_KNOWN_EVENTS.has(event)) { status = status === 'unsupported' ? status : 'unknown'; notes.push(`event ${event} not confirmed for Codex; fallback: run it from the hub runner`); }
        let codexCommand = command;
        if (command.includes('${CLAUDE_PLUGIN_ROOT}')) {
          codexCommand = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot.replace(/\\/g, '/'));
          if (status === 'native') status = 'adapted';
          notes.push('${CLAUDE_PLUGIN_ROOT} replaced by the absolute plugin path');
        }
        if (status !== 'unsupported' && !h.type) notes.push('hook type not stated; assumed "command"');
        out.push({ event, command, ...(g.matcher ? { matcher: g.matcher } : {}), codex: status, notes, codexCommand });
      }
    }
  }
  return out;
}
