// Generates design/tokens.css, design/tokens.json and web/css/tokens.css from design/themes.json. Never edit the outputs by hand.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const themes = JSON.parse(readFileSync(join(root, 'design', 'themes.json'), 'utf8'));

const shared = {
  'font-ui': "'Golos Text', 'Segoe UI', system-ui, sans-serif",
  'font-mono': "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace",
  'type-display': '650 30px/36px var(--hub-font-ui)', 'track-display': '-0.02em',
  'type-title': '620 22px/30px var(--hub-font-ui)', 'track-title': '-0.012em',
  'type-heading': '600 16px/24px var(--hub-font-ui)', 'track-heading': '-0.006em',
  'type-body': '440 15px/23px var(--hub-font-ui)',
  'type-label': '520 14px/20px var(--hub-font-ui)',
  'type-meta': '450 12px/16px var(--hub-font-ui)', 'track-meta': '0.01em',
  'space-1': '4px', 'space-2': '8px', 'space-3': '12px', 'space-4': '16px', 'space-5': '24px', 'space-6': '32px', 'space-7': '48px',
  'radius-control': '12px', 'radius-card': '16px', 'radius-sheet': '26px', 'radius-pill': '999px',
  'target-min': '44px', 'target-primary': '46px', 'time-col': '62px',
  'motion-fast': '120ms', 'motion-base': '200ms', 'ease': 'cubic-bezier(.2,.7,.2,1)', 'blur-chrome': '26px', 'blur-plane': '22px',
};
const bridge = { background: 'bg', foreground: 'ink', card: 'surface', 'card-foreground': 'ink', popover: 'surface', 'popover-foreground': 'ink', primary: 'accent', 'primary-foreground': 'on-accent', secondary: 'surface-2', 'secondary-foreground': 'ink', muted: 'surface-2', 'muted-foreground': 'muted', accent: 'accent-soft', 'accent-foreground': 'accent-soft-ink', destructive: 'danger-ink', border: 'line', input: 'input-border', ring: 'ring' };
const sel = { 'green-dark': ':root,\n[data-theme="dark"][data-accent="green"]', 'green-light': '[data-theme="light"][data-accent="green"]', 'orange-dark': '[data-theme="dark"][data-accent="orange"]', 'orange-light': '[data-theme="light"][data-accent="orange"]' };

const css = ['/* Agent Hub design tokens — generated from design/themes.json by design/build-tokens.mjs. Do not edit by hand. */', ':root {', ...Object.entries(shared).map(([k, v]) => `  --hub-${k}: ${v};`), '}'];
for (const [name, t] of Object.entries(themes)) {
  css.push(`${sel[name]} {`, `  color-scheme: ${name.endsWith('dark') ? 'dark' : 'light'};`, ...Object.entries(t).map(([k, v]) => `  --hub-${k}: ${v};`), ...Object.entries(bridge).map(([k, v]) => `  --${k}: var(--hub-${v});`), '}');
}
const text = css.join('\n') + '\n';
for (const p of [join(root, 'design', 'tokens.css'), join(root, 'web', 'css', 'tokens.css')]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
writeFileSync(join(root, 'design', 'tokens.json'), JSON.stringify({ shared, themes }, null, 2));
console.log(`tokens: ${Object.keys(themes).length} themes, ${Object.keys(themes['green-dark']).length} tokens each`);
