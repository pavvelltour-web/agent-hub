# Study S1 — first admin screens, iPhone-type glass

> Pipeline: `product-ui-workbench` 0.10.1 (iphone-glass, ux-hierarchy, design-first, paired-themes, candidate-comparison) + `design-quality-loop` 2.0.
> Status vocabulary: **observed** (seen in a viewed image) · **inferred** · **proposed** (ours) · **approved** (user only). Nothing here is approved.
> Reference pixels are private (`refs-private/`, git-ignored). Only canonical links/descriptions are kept here.

## 1. Sources viewed

| ID | Source | Role | Viewed |
|---|---|---|---|
| U1 | User upload 1 — "Alerts" glass panel | material: clear glass sheet over dark scene, neon edge light, segmented tabs, colored icon tiles | yes |
| U2 | User upload 2 — three cards with colored bottom glow | accent light: color lives in the lower edge glow, card body stays dark and readable | yes |
| U3 | User upload 3 — dark navy dashboard ("Good Evening, Aaru") | composition: icon rail + card grid; ambient orange/blue blobs behind glass | yes |
| P03 | Pinterest (RonDesignLab "Automatic Payment") | material: visionOS-like frosted window over blurred photo, pill nav lens, floating side rail | yes |
| P08 | Pinterest ("Amplify" music) | material: one large glass window, dense list rows as inner lighter plates, colored blur continues through glass | yes |
| P10 | Pinterest ("NoteWise") | material: glass panel floating over colored content blocks that remain visible through it | yes (sheet) |
| P04/P09 | Pinterest finance dashboards | counter-example: everything equally loud, metrics first, charts with no decision | yes (sheet) |
| A1 | apple.com newsroom, Liquid Glass "clear look" | light material: clear controls over a real light photo | yes |
| — | Mobbin | **not used**: MCP not loaded in this session; web returns 403 | — |
| — | X/Twitter | **not used**: search requires login | — |

## 2. Decomposition (observed → what we take)

| Trait | Observed | Take as (proposed) |
|---|---|---|
| T1 Layers | P03, P08: background scene → one large glass window → denser inner plates for records | 3 layers: scene · clear chrome (nav, dock) · readable work planes |
| T2 Color through glass | P08, P10: colored blur visible through the panel edge | scene blobs placed so an accent color passes behind the nav lens |
| T3 Edge light | U1 left neon rim; U2 bottom glow in accent | accent glow only on the **one** card that needs a decision; nowhere else |
| T4 Rim | U1, P03: thin bright top/left rim, darker bottom | 1 px inner rim gradient, stronger on top-left |
| T5 Pills | P03, U1: pill tabs inside glass, selected pill is solid light | segmented scope control as pills; selected = solid plate |
| T6 Density | P08: rows are inner plates with lighter fill; text high contrast | rows on inner plates, opaque enough for 14 px text |
| T7 Counter-example | P04, P09, U3: equal-weight KPI cards and charts lead | do **not** lead with metrics; numbers only where they change a decision |
| T8 Light glass | A1: clear controls on a light photo, dark ink | light theme = pale scene + white-tinted glass + dark ink, not inverted dark |

## 3. Screen intent (proposed — the user supplied the goal "logical UX, useless info must not lead")

The hub exists to keep work moving across agents. The first thing the user must see is **what is blocked on them right now** and the one action that unblocks it. Everything else is secondary or one click away.

| Screen | First useful object | Why it leads | Action |
|---|---|---|---|
| Today | the decision waiting for you (Codex hit its limit on T016) | work is stopped until you choose | hand over to Claude Sonnet / wait for reset |
| Task T016 | why it stopped + what the next agent will get (handoff card) | you approve a handoff, so you must see its content | hand over |
| Toolkit (stage 3) | proposed tools with reason, token cost and agent compatibility | you approve what goes into the project | review changes → approve |

Deliberately **not** leading: totals, cost charts, history, agent lists, weekly activity.

## 4. Two structural concepts (V15-P02: differ by organization of work, not only color)

| | A · Lens Console | B · Floating Studio |
|---|---|---|
| Accent | bright green | orange |
| Navigation | floating vertical glass rail (left) | floating pill tab lens (top center) |
| Today layout | decision card full width on top → "running now" list + slim limits column | one large glass window; decision hero left, limits stack right; running list as inner plates below |
| Task layout | two columns: handoff card · event timeline | single column story: status → card → timeline (reading order) |
| Toolkit layout | table-like list with compat columns + sticky summary bar | cards per tool with toggles + bottom dock summary |
| Trade-off | denser, faster scanning for many tasks | calmer, more "iPhone", fewer items visible at once |

## 5. Material recipe (proposed values)

- Scene: 2–3 large blurred blobs (accent + one cool + one warm) on near-black (dark) or pale tinted paper (light), fixed to the document.
- Clear chrome: fill 8–14 % white (dark) / 55 % white (light), `backdrop-filter: blur(24px) saturate(160%)`, rim 1 px, shadow `0 10px 30px` low alpha.
- Work plane: fill 62–72 % surface (dark) / 72 % white (light), blur 20 px; text must pass on the **resulting** pixels.
- Inner plate (rows): +4–6 % lighter than the plane.
- Decision glow: accent radial gradient under the bottom edge, 1 px accent rim.
- Opaque fallback: `?material=opaque` and `prefers-reduced-transparency` → blur none, opaque fill, same geometry.

## 6. Typography roles (Golos Text)

page 28/34 600 · entity 20/28 600 · section 16/24 600 · body 14/21 400 · label 14/20 500 · meta 12/16 400 (tabular for time).

## 7. Honest limits of this study

- shadcn MCP and Mobbin MCP were not available in this session; components are hand-built HTML with shadcn-compatible roles. **Library correctness gate: not-run.**
- Static images cannot establish motion or native refraction; blur values are proposals.
- Browser checks are local Chrome slices, not an accessibility certification or physical-iPhone evidence.
- Human acceptance: pending.
