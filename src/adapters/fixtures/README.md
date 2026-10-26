# Adapter fixtures

All content is synthetic. Nothing was copied from local history or from any session. Every file is named `*.unverified.jsonl`
because neither CLI could be recorded live on this machine (claude is not signed in, codex rejected the configured model).

## Shapes seen in local history (observed shape, synthetic content)

Read only for the line SHAPES in `~/.claude/projects/**/*.jsonl` (interactive transcripts, not `stream-json` output):

- `tool_use` block: `{ type, id, name, input }`; `tool_result` block: `{ type, tool_use_id, content }` where content is a string or an array of `{ type: 'text', text }`.
- `thinking` block: `{ type: 'thinking', thinking, signature }`.
- `Edit` input: `{ file_path, old_string, new_string, replace_all? }`.
- `TodoWrite` input: `{ todos: [{ content, activeForm, status }] }`.

Codex `~/.codex/sessions/**` uses a different (rollout) format from `codex exec --json`, so it confirms only that reasoning,
function calls and call outputs exist, not the `exec --json` item shapes.

## From documentation or memory only (unverified)

- `MultiEdit` input `{ file_path, edits: [{ old_string, new_string }] }`.
- Claude `result.duration_ms` (seen in a real not-logged-in result, so the field exists; not seen on a success path here).
- `stream_event` with `--include-partial-messages`: `{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }`.
- Codex `exec --json` items: `command_execution` (`id, command, aggregated_output, exit_code, status`), `file_change` (`changes: [{ path, kind }]`),
  `reasoning` (`text`), `todo_list` (`items: [{ text, completed }]`), `item.started`.

Replace these with real recordings (observed) once both CLIs are signed in.
