# ADR-015: the prompt goes through stdin, never through arguments

Context: Windows command lines are limited to ~32k characters; handoff prompts exceed that. Arguments also invite quoting and injection bugs.
Decision: agents are started without a shell, with an argument array; `claude -p` and `codex exec -` read the prompt from stdin. Verified: a 50 000-character prompt arrives intact (adapter test); Codex needs stdin closed or it waits ("Reading additional input from stdin").
