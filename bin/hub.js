#!/usr/bin/env node
// Entry point. Published package: compiled JS in dist/. Source checkout: Node strips TypeScript types on the fly.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 24+ (node:sqlite, TypeScript type stripping). Say so plainly instead of failing on a missing module.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`hub: Node.js 24 or newer is required (this is ${process.versions.node}). Установите Node.js 24+: https://nodejs.org`);
  process.exit(1);
}
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w.stack); });
// --home DIR: use another data folder (tests, demos). Must be set before the modules load.
const hi = process.argv.indexOf('--home');
if (hi > 0 && process.argv[hi + 1]) process.env.AGENT_HUB_HOME = process.argv[hi + 1];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'cli', 'main.js');
// Node does not strip types inside node_modules, so an installed copy without dist/ cannot run the TypeScript source: say it, do not crash.
if (!existsSync(dist) && /[\\/]node_modules[\\/]/.test(root)) {
  console.error('hub: this copy has no compiled dist/ and Node cannot run TypeScript from node_modules. Use a source checkout (git clone, then node bin/hub.js) or build with `npm run build` first.');
  process.exit(1);
}
await import(pathToFileURL(existsSync(dist) ? dist : join(root, 'src', 'cli', 'main.ts')).href);
