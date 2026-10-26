# Reconstruction prompt — study S1 (pinned before source)

Build an original, static, local prototype of three Agent Hub admin screens (Today, Task T016, Toolkit stage 3) in two structural concepts (A Lens Console / green, B Floating Studio / orange), each in dark and light. Route: `index.html?v=a|b&theme=dark|light&screen=today|task|toolkit[&material=opaque]`. Synthetic fixture only, Russian UI copy. No external assets except Google Fonts (Golos Text, JetBrains Mono).

## Keep (from references, by trait id — see STUDY.md §2)

- T1 three layers: fixed scene → clear chrome (nav, dock) → readable work planes; inner plates for rows.
- T2 the scene's accent blob passes behind the navigation lens so color continues through glass.
- T3 accent edge glow only on the single decision card (bottom radial glow + 1px accent rim).
- T4 1px inner rim, brighter top-left; low-alpha occlusion shadow.
- T5 pill segmented control; selected pill is a solid light plate with dark ink.
- T6 rows are inner plates, opaque enough for 14px text; ink contrast checked on the composited pixels.
- T8 light theme is a deliberate recipe: pale tinted scene, white-tinted glass, dark ink — not an inversion.

## Change / reject

- T7 reject equal-weight KPI grids and charts as the first object; no chart on these screens.
- No copied logos, copy or data from references. Product identity "agent hub".

## UX contract (ux-plan-today.json + same principles for task/toolkit)

- Today: first object = decision card "T016 · Codex упёрся в недельный лимит" → primary "Передать Claude Sonnet 5.5" (46px), secondary "Подождать сброса · 2 д 4 ч", tertiary "Карточка передачи" (opens dialog; Escape closes; focus returns). Then scoped list (pills "Ждут вас 3 / Идут 2 / Все 5", counts from the same array). Then limits as remaining share + reset only.
- Task: status line (why stopped) → handoff card (facts from git/logs; summary: goal, done, stopped at, next steps, open questions) → proposed agent with reason and estimate range marked "низкая уверенность" → trimmed event timeline (time column 62px nowrap) → diff stat.
- Toolkit: 5 proposals with reason, token cost per turn, compatibility Claude/Codex (native/adapted), license, risk; mandatory items locked; summary "+N токенов на ход · K адаптаций" → "Проверить изменения" opens diff dialog.
- Mobile 390px: context line → decision card with primary in first fold → waiting list → running → limits. Rail/tab lens becomes a bottom glass dock with 4 items, ≥44px targets.

## Type roles (Golos Text)

page 28/34 600 · entity 20/28 600 · section 16/24 600 · body 14/21 400 · label 14/20 500 · meta 12/16 400.

## Tokens

Use `design/tokens.css` colors (green for A, orange for B). Glass-specific values are proposals defined in the prototype stylesheet and listed in STUDY.md §5. Opaque fallback via `material=opaque` and `prefers-reduced-transparency`: same geometry, blur none, opaque fill.

## Budget

2 source iterations per concept; findings recorded, not silently fixed in the prompt.
