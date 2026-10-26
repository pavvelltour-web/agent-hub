# Study S1 — review and candidate comparison

> Status: **candidates for your choice**. Human acceptance: pending. Independent critique by another reviewer: not-run. Library correctness (real shadcn components): not-run.

## What was built

`design/prototypes/index.html?v=a|b&theme=dark|light&screen=today|task|toolkit[&material=opaque]` — static, synthetic data, Russian UI.
Served locally at `http://localhost:8765/prototypes/index.html` (launch config "Agent Hub design preview").

## Evidence (real Chrome via Playwright, 1440×900 and 390×844)

| Check | Result | Where |
|---|---|---|
| Horizontal overflow | 0 px in 24/24 captures | `captures/iter3/evidence.json` |
| Golos Text loaded | 24/24 | same |
| Standard `backdrop-filter` computed on glass | `blur(26px) saturate(1.65)` in 24/24 | same |
| Primary action 46 px and inside the first fold | 24/24 | same |
| Smallest text | 12 px (metadata only) | same |
| Today: open handoff card → identity "T016" → Escape closes → focus returns to opener | pass in 8/8 Today captures | same + `*-dialog.png` |
| Toolkit: diff dialog opens | 8/8 | same |
| Sampled text contrast on composited pixels (diagnostic, not certification) | header meta 7.5–14.6; body 4.7–15.3 | same |

## Candidates

| | **A · Lens Console** (green) | **B · Floating Studio** (orange) |
|---|---|---|
| Structure | floating vertical glass rail; decision card full width; two columns below (work · limits) | floating pill tab lens; one large glass window; decision + limits side by side, work below |
| Glass feel | clear rail + translucent planes; green light passes through the decision card | one big frosted window with lighter inner plates (closest to the visionOS/P03 and Amplify/P08 references) |
| Density | higher: more rows visible, table-style toolkit | calmer: cards and toggles, fewer items per screen |
| Task screen | two columns: who continues + card │ timeline | single reading column: who continues → card → timeline |
| Best for | many tasks/agents in parallel, fast scanning | focused daily decisions, "iPhone" feel |
| Trade-off | busier, rail takes horizontal space | needs more scrolling; toolkit summary dock floats over content |

Both share: the first object on Today is the decision blocking work (T016 handoff), escalated work (T017) is visible without a click, numbers appear only where they change a decision (limits as remaining share + reset), no charts.

## Remaining findings (not fixed)

| ID | Finding |
|---|---|
| F9 | Full-page PNG exports show the fixed scene/dock/sticky bar at viewport positions; live scrolling is correct. |
| F12 | Toolkit filter pills wrap to two lines at 390 px. |
| — | Mobbin and shadcn MCP were not loaded in this session: references came from your 3 uploads, Pinterest (12 viewed), Apple Liquid Glass; X needs login. Components are hand-built. |
| — | Safari/physical iPhone, motion and native refraction not evaluated. |

## What I need from you

Pick a direction per axis (they can be mixed): structure A or B, accent green or orange, and anything you'd change in what leads each screen.
