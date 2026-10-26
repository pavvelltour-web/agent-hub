# Agent Hub — Design System v0.1

> Status: **proposed**. Human acceptance pending. Contrast values below are computed from the tokens (WCAG 2.x formula), not a full accessibility audit.
> Process owner: the user's `product-ui-workbench` pipeline (V15) + `design-quality-loop`. This system formalizes the direction the user preferred in V14/V15: dense near-black/olive/charcoal work planes with a green or orange semantic accent; glass only for navigation chrome.

Files:

| File | Purpose |
|---|---|
| `themes.json` | source of truth for the four color recipes |
| `tokens.css` | generated CSS variables (`--hub-*`) + shadcn/ui variable bridge (`--background`, `--primary`, …) |
| `tokens.json` | generated DTCG-style tokens for other tools |
| `preview.html` | live board of all four themes (serve over HTTP) |

Regenerate CSS/JSON from `themes.json`; never edit `tokens.css` by hand.

## 1. Themes

Selected by two attributes on `<html>` (or any container): `data-theme="dark|light"` and `data-accent="green|orange"`. Default is dark + green.

| Theme | Background | Surface | Ink | Accent (fill) | On-accent | Accent as text |
|---|---|---|---|---|---|---|
| Dark · Green | `#0c100b` | `#161c14` | `#eef5e8` | `#8cff5a` bright green | `#102a05` | `#a3ff7a` |
| Light · Green | `#f3f7ef` | `#ffffff` | `#111a0e` | `#6fe23a` bright green | `#0e2804` | `#2a6a12` |
| Dark · Orange | `#13110f` | `#1f1b17` | `#f8f1e8` | `#ff8a3d` bright orange | `#2b1102` | `#ffa266` |
| Light · Orange | `#faf6f1` | `#ffffff` | `#1c150f` | `#ff7a2e` bright orange | `#2a0f01` | `#a8460b` |

Rules:

- **Accent fill ≠ accent text.** Bright fills carry dark `on-accent` ink. On light themes, accent-colored text and links use the darker `accent-text` token (bright green/orange on white is unreadable).
- **Light themes need `accent-edge`** (`#3b8a1a` green, `#c2540f` orange) on accent-filled controls: the bright fill alone is only 1.5–2.4:1 against the page.
- **Warning is yellow, not orange**, so it never collides with the orange accent.
- **Status colors are shared** across accents; only the accent family changes.
- **A palette change is not a new design.** Dark and light are deliberate paired recipes of the same structure (workbench `paired-themes` rule), not CSS inversion.

## 2. Measured contrast (computed)

| Pair | Dark·Green | Light·Green | Dark·Orange | Light·Orange | Minimum |
|---|---:|---:|---:|---:|---:|
| ink / bg | 17.2 | 16.4 | 16.8 | 16.8 | 4.5 |
| muted / surface-2 | 7.9 | 6.5 | 8.0 | 6.8 | 4.5 |
| on-accent / accent | 12.2 | 9.5 | 7.6 | 6.9 | 4.5 |
| accent-text / surface-2 | 12.4 | 5.6 | 7.7 | 5.0 | 4.5 |
| accent-soft-ink / accent-soft | 11.2 | 8.0 | 9.7 | 6.9 | 4.5 |
| ring / bg | 15.7 | 6.1 | 9.5 | 5.5 | 3.0 |
| input-border / surface | 3.8 | 3.5 | 3.6 | 3.9 | 3.0 |
| accent-edge / bg | 15.1 | 4.0 | 8.0 | 4.3 | 3.0 |
| status ink / status bg (min of 4) | 7.8 | 5.8 | 7.8 | 5.8 | 4.5 |

Per V15-P03/P04: these are token-level numbers. Every actual consumer (active nav, primary CTA, toast/Undo, portals, error text) must still be checked in the rendered build.

## 3. Typography

Font: **Golos Text** (Cyrillic), mono **JetBrains Mono** for time, IDs and code. Bundle fonts locally in the app; the preview uses Google Fonts only for convenience.

| Role | Token | Spec | Use |
|---|---|---|---|
| Display | `--hub-type-display` | 600 28/34 | key number on a card |
| Title | `--hub-type-title` | 600 20/28 | screen title |
| Heading | `--hub-type-heading` | 600 16/24 | card/section heading |
| Body | `--hub-type-body` | 400 14/21 | default text |
| Label | `--hub-type-label` | 500 14/20 | buttons, nav, captions |
| Meta | `--hub-type-meta` | 400 12/16 | metadata, table headers, timestamps |

Floors from the user's V15 rules: body and captions ≥ 14 px, metadata ≥ 12 px. Numbers use tabular figures (`.hub-num`, `time`).

## 4. Space, shape, size

- Spacing scale (4-px base): 4 · 8 · 12 · 16 · 24 · 32 · 48 (`--hub-space-1…7`).
- Radius: control 6 · card 10 · sheet 14 · pill 999.
- Touch targets: minimum 44 px; **primary CTA 46 px and non-shrinking** (V15-P05: measure after flex layout).
- Dense desktop controls: 36 px, only where a 44 px alternative exists for touch.
- Event time column: 62 px, `nowrap` on the time value only (V15-P06).

## 5. Material

- Work surfaces (tables, documents, history, queues) are **opaque** (`surface`, `surface-2`).
- Glass (`--hub-glass` + `blur(16px)`) only for the top navigation and floating controls; always provide the opaque fallback.
- Dark themes: no shadows. Light themes: one soft shadow token.

## 6. Components (first set)

| Component | Job | Notes |
|---|---|---|
| Limit meter | remaining weekly/session limit per account | shows "no data" honestly; estimates marked as estimates |
| Task queue row | task, agent, model+effort, status, time | selected row = `accent-soft` |
| Handoff card | who stopped, why, what's next | left accent rule; actions: hand off / details / cancel |
| Stage stepper | 8 lifecycle stages with gate state | "waiting for your OK" is a distinct state |
| Approval diff sheet | what will be written where | primary = approve, ghost = reject; never auto-approve |
| Library item | skill/plugin/MCP with token cost, license, compat per agent | risk badge |
| Status chip | done / running / limit / failed | shared status palette |
| Session timeline | unified Claude + Codex history | agent identity via label + icon, not color alone |

Different jobs get different forms; more identical cards is not richer design (workbench rule).

## 7. Mapping to shadcn/ui

`tokens.css` sets the standard shadcn variables from the hub tokens, so shadcn components and the user's workbench library consume the same palette without per-component overrides:

`--background ← bg`, `--foreground ← ink`, `--card ← surface`, `--primary ← accent`, `--primary-foreground ← on-accent`, `--accent ← accent-soft`, `--muted-foreground ← muted`, `--border ← line`, `--input ← input-border`, `--ring ← ring`, `--destructive ← danger-ink`.

## 8. How to change it

1. Edit `themes.json`.
2. Regenerate `tokens.css` / `tokens.json`.
3. Re-run the contrast check; every pair in §2 must meet its minimum.
4. Render `preview.html` in all four themes at desktop and 375 px, inspect real consumers.
5. Record the change as proposed until you accept it.
