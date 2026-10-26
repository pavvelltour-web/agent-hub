# Study S1 — findings and prompt revisions

Pinned prompt and UX plan are not edited. Each revision cites findings from captured evidence (`prototypes/captures/iterN/evidence.json` + viewed PNG sheets).

## Iteration 1 → findings (observed)

| ID | Where | Finding | Evidence |
|---|---|---|---|
| F1 | A dark, Today/Toolkit header | context meta and intro text sit on the bright green scene blob: sampled contrast 2.85 (meta), 3.51 (intro) | evidence.json c_meta/c_body |
| F2 | all, Toolkit 390px | page overflows horizontally by 3px | evidence.json overflowX=3 |
| F3 | light themes | muted text on glass samples 4.3–4.8 (diagnostic), at the 4.5 edge | evidence.json |
| F4 | Today (UX) | T017 is in escalation (failed twice) but hidden behind the "Идут" pill; the plan lists running tasks as a visible secondary group, pills make them one click away | _sheet-a/b-desktop.jpg |
| F5 | B, all screens | prototype switcher overlaps the floating tab lens | _sheet-b-desktop.jpg |
| F6 | B, inner cards | plane-inside-plane: double blur makes inner cards dull, not glass; references P08 use lighter inner plates | _sheet-b-desktop.jpg |
| F7 | A dark | scene barely shows through planes; reads as dark cards, not iPhone glass (T1/T2 weak) | _sheet-a-desktop.jpg |
| F8 | A, Toolkit table | compatibility chips truncate and collide ("адаптация · junctio…", "config.t MIT") | _sheet-a-desktop.jpg |

## Revision R1 (prompt delta, budget 2 → 1 remaining)

| Finding | Responsible module | Change | Expected visible difference |
|---|---|---|---|
| F1, F7 | scene + plane material | A: move accent blob behind the decision card/actions (right), keep header on dark scene; dark plane fill 64 % → 50 % | green light visibly passes through decision card and limits; header meta ≥ 4.5 |
| F3 | light plane | light plane fill .62 → .70 | muted ≥ 4.5 on glass |
| F4 | Today composition | replace pills with two always-visible groups: "Ещё ждут вас" and "Идут сейчас"; escalated task marked | T017 escalation visible without a click |
| F5 | study switcher | collapsed by default on every width | no overlap with tab lens |
| F6 | B inner surfaces | inner cards inside the window become plates (no second blur) | lighter inner plates like P08 |
| F2 | toolkit bar/cards | `min-width:0`, wrapping on chips and bar | overflowX = 0 |
| F8 | toolkit table | chips show only "как есть"/"адаптация"; target note goes to a meta line; wider columns | no truncation |

## Iteration 2 → findings (observed)

All F1–F8 resolved in captures `iter2` (overflow 0 everywhere, header meta 7.5–14.6 sampled, dialog open/Escape/focus pass in 8/8 Today captures). New:

| ID | Where | Finding |
|---|---|---|
| F9 | full-page PNG export, B dark | the fixed scene ends at the first viewport, leaving a flat band in full-page captures; live scrolling is unaffected (scene is fixed) — **remaining, not fixed** |
| F10 | B Today 390px | limits appear before waiting/running groups; plan order says limits last |
| F11 | all 390px | prototype switcher overlaps a list row above the dock (study chrome, not product UI) |

## Budget extension (audited, one time)

Budget was 2. A third, mobile-only render was authorized by the coordinator (this session) for F10/F11 because they violate the pinned mobile order and hide content. Iteration history is kept; this does not reset the budget. Captures: `iter3`.

Deviation from the pinned UX plan: F4 removes the pill scope control from Today (`controls.filter_scope`). Reason: escalated work must not hide behind a filter. The plan file is not rewritten; this record is the authorized change for review.
