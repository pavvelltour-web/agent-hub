## Rules for automations, bots and agents
- **Safe by default.** Every action that changes something outside the code (send a message, write to a CRM, move money, delete) has a dry-run mode and asks a human first until the user turns that off.
- **Repeatable.** Handlers are idempotent: running the same event twice has the same result. Use idempotency keys and store processed event ids.
- **Failure.** Set a timeout on every external call, retry with backoff and a limit, then fail loudly with a clear message to the operator. Never retry forever.
- **Limits and cost.** Respect each service's rate limits. Cap the cost and the number of steps per run; stop and report when a cap is hit.
- **Secrets.** Tokens and keys come from environment variables. Verify webhook signatures. Logs never contain tokens or personal data.
- **Prompts are code.** Keep prompts in files under version control, with a short note of what changed and why.
- **Evals.** Keep a few frozen example tasks with expected results; run them before changing a prompt, a model or a tool.
- **Observability.** One log line per step: run id, step, outcome, duration, tokens. A failed run can be replayed from its log.
- **Done also means:** one successful run and one deliberately failed run were observed, with logs attached.
