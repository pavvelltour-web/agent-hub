#!/usr/bin/env node
// Entry point. Published package: compiled JS in dist/. Source checkout: Node strips TypeScript types on the fly.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w.stack); });
// --home DIR: use another data folder (tests, demos). Must be set before the modules load.
const hi = process.argv.indexOf('--home');
if (hi > 0 && process.argv[hi + 1]) process.env.AGENT_HUB_HOME = process.argv[hi + 1];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'cli', 'main.js');
await import(pathToFileURL(existsSync(dist) ? dist : join(root, 'src', 'cli', 'main.ts')).href);
