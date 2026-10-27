# ADR-020: a run starts only the skills and MCP servers its work mode needs

Context: every skill listing and every MCP tool list a Claude Code session loads is paid on every turn. The work mode already says what a task is for, so it can also say what the run may load. The risk is on the other side: a flag that hands the agent a server definition is a way to run a command.

Decision (`src/run/lean.ts`, `leanPlan`):
- **Skills.** A mode whose `skills` list is empty starts with `--disable-slash-commands`; a mode that lists skills (autopilot) keeps them. A run without a mode keeps the old class rule (mechanical, summary).
- **MCP.** A mode may carry `mcp: [names]`. The run gets `--strict-mcp-config --mcp-config <file>` holding only the names the task needs. The caller can narrow the mode's list, never widen it. A mode without `mcp` leaves MCP exactly as the user configured it.
- **Where a definition comes from.** Only the hub library (`mcp/<name>` entries: shipped catalog and `<hub home>/registry`). Never the project's `.mcp.json`: `--mcp-config` is trusted without the approval prompt project-scoped servers get, so a repository could name a hostile command under a known server name.
- **No values in the file.** Env vars are written as `${NAME}` references (names validated `[A-Za-z_][A-Za-z0-9_]*`), urls must be `http(s)://`, headers are not carried. Claude expands the references from the already filtered process environment.
- **All or nothing.** If any needed server cannot be built (unknown name, unsafe field, file not writable) no MCP flag is passed, MCP stays as it was, and the run gets a `warn` event saying which server and why. A half list would silently remove a tool the mode needs.
- **File handling.** Created with `wx` (never overwrites) and `0600` in `<hub home>/tmp`, not the project folder and not a shared temp folder; removed when the process ends (`cleanup`). `--mcp-config` takes several values, so it is the last flag emitted. Review-gate reviewers (`isolatedCwd`) get no lean flags at all.
- **Codex.** Nothing is passed: Task 1.2 verified `sandbox_mode` and `model_reasoning_effort` only; no `-c` key for skills or MCP is verified.

Status: flags are in `claude --help` (observed, v2.1.114); argument assembly, file contents, cleanup and the warn are tested with a fake agent. The effect on a real session's first-call size was **not measured** (CLI not signed in), and the expansion of `${NAME}` inside `--mcp-config` files is documented behaviour of `.mcp.json` that was **not run live** here.
Tests: `src/run/lean.test.ts`, `src/run/run.test.ts` (lean tool sets).
