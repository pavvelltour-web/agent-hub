# REVIEW.md

Review rules for this project. The reviewer reads them together with AGENTS.md. One line per rule.

## What counts as broken here
Broken: tokens that disagree with DESIGN-SYSTEM.md, hard-coded colors outside the tokens, a screen not checked in all themes. Add your own items as a list.

## Do not check
What the reviewer should skip: generated files, third-party code, formatting. One line per item.

## Paths that need a human
Tokens and the DESIGN-SYSTEM.md file: a human shows any change. List the paths: `design/tokens.css`, `design/DESIGN-SYSTEM.md`.

## Nit limit: 5
At most five remarks about small things (style, names) per round; do not show the rest.

## Evidence: file and line
Every remark names the file and the line and quotes the code. A remark without this is not accepted.
