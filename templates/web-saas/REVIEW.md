# REVIEW.md

Review rules for this project. The reviewer reads them together with AGENTS.md. One line per rule.

## What counts as broken here
Broken: sign-in and access rights, payments and subscriptions, data migrations, secrets in browser code, API answers that do not validate their input. Add your own items as a list.

## Do not check
What the reviewer should skip: generated files, third-party code, formatting. One line per item.

## Paths that need a human
Sign-in and sign-out, payments, migrations, access rights. List the paths: `src/auth/**`, `migrations/**`.

## Nit limit: 5
At most five remarks about small things (style, names) per round; do not show the rest.

## Evidence: file and line
Every remark names the file and the line and quotes the code. A remark without this is not accepted.
