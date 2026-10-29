# Security policy

Agent Hub runs coding agents, writes their configuration files and installs third-party components, so its security model matters. The full threat model (T1–T10) is in [docs/SECURITY.md](docs/SECURITY.md) (in Russian).

## Supported versions

Only the current `main` branch. The project is `0.x`: there are no maintained older lines.

## Reporting a vulnerability

Please **do not open a public issue with exploit details.**

1. Use GitHub's private reporting: the **Security** tab of this repository, **Report a vulnerability**. (If the button is missing, private reporting is not enabled yet. The owner enables it in Settings → Code security.)
2. If that is not available, open a public issue that says only *"I found a security problem, please enable private reporting"* and contains no details. The owner will answer there.

Include: what you did, what you expected, what happened, the version (`git rev-parse HEAD`) and your OS. Fixes are made on a best-effort basis; there is no guaranteed response time.

## What the hub promises

- The panel listens on `127.0.0.1` only, needs a session token (HttpOnly, SameSite=Strict cookie), and checks the `Host` and `Origin` headers.
- Agents it starts cannot `git push`; hub secrets are removed from their environment; processes are started with argument arrays, never shell strings.
- Writes into a project go through a plan that you approve, with a backup and an undo.
- The history of other agents (`~/.claude`, `~/.codex`) is read-only; credential files are never read.
- Text from outside (registry entries, READMEs, tool output, plans written by a model) is treated as data, not instructions.

## What it does not promise

- It cannot protect you from code that you approved yourself after looking at it.
- It has **not** been verified against every version of the Claude and Codex command-line tools; see [docs/STATUS.md](docs/STATUS.md) for what was observed and what was not.
- `gitleaks`, `semgrep` and `trivy` run only when Docker is available (`node scripts/security.mjs --docker`); without it only the built-in checks run.

## Out of scope

Vulnerabilities in the Claude or Codex CLIs themselves, in third-party skills or MCP servers that you chose to install, or attacks that need local administrator rights on your machine.
