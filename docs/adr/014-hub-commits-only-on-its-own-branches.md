# ADR-014: the hub commits only on `hub/*` branches

Context: a handoff checkpoint needs the unfinished work saved. A run in the user's own working tree must not get a commit made on their behalf.
Decision: `writeCard` commits (without skipping repo hooks) only when HEAD is a `hub/<task>/<agent>` branch created by the hub. In any other branch it records the changed files and `checkpoint_committed: false` with the reason. The hub's own `.hub/` folder is excluded from "files changed". Tests: `run.test.ts` (both cases).
