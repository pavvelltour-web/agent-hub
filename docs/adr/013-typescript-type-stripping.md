# ADR-013: TypeScript runs through Node type stripping; `tsc` builds for publishing

Decision: development runs `.ts` directly (Node 24) with `erasableSyntaxOnly` (no enums, parameter properties, namespaces). `tsc -p tsconfig.build.json` (with `rewriteRelativeImportExtensions`) emits `dist/` for the published package, because Node refuses to strip types inside `node_modules`. `bin/hub.js` picks `dist/` when present.
Consequence: minimum Node 24 for development; the published package needs a Node with `node:sqlite` (22.13+ is expected to work, to be verified before publishing).
