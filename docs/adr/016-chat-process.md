# ADR-016: one process per chat message (`--resume`), a persistent process is not adopted yet

Status: decided for now; **the spike behind the alternative is unverified** and must be run once `claude` is signed in.

Context: every chat message starts `claude -p … --resume <session>`. A long-lived `claude -p --input-format stream-json --output-format stream-json --verbose` process could serve several user messages and might reuse the prompt cache between turns, which would save a cold start and cache writes per message.

What was observed (this PC, 2026-10-26):
- `claude --help` lists `--input-format stream-json` ("realtime streaming input"), `--include-partial-messages` and `--replay-user-messages` (observed).
- `claude auth status` reports `loggedIn: false`, so no live run is possible and the spike could not be done (observed). Nothing below about cache reuse or interrupt behaviour has been measured.

Decision: keep one process per message with `--resume`. It is the verified path: the session id is stored per run, resume keeps the permission (Phase 1), a stop kills exactly one process, and a crashed process cannot take a chat with it. The hub does not need a process table, idle timers or half-closed pipes.

Spike to run when signed in (≈ 5 minutes, writes results here as **observed**):
1. `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`; write two user lines (`{"type":"user","message":{"role":"user","content":"…"}}`) to stdin, the second after the first `result` line.
2. Record `usage.cache_read_input_tokens` of turn 2 against a plain `--resume` run of the same two prompts (cache reuse), and wall time of turn 2.
3. Interrupt: close stdin and send SIGTERM mid-turn; record whether the session file stays resumable.

Adopt only if turn 2 reads the cache at least as well as `--resume` AND an interrupted chat stays resumable. Then: a chat keeps its process alive for ≤ 5 minutes idle (the cache TTL), otherwise it exits and the next message falls back to `--resume`. The fallback is never removed.

Consequences: no code change in `src/adapters/process.ts` or `src/run/runner.ts` in this phase.
