## Rules for a design study
- **Deliverables, not production code.** Output goes to `design/` and `research/`. Do not change application code unless the user asks.
- **Evidence.** Every design decision cites a reference (a screen, an app, a rule) saved in `research/`. Never invent data, quotes, users or metrics; mark assumptions as assumptions.
- **At least two options.** Show two distinct directions side by side with a short reason for each, then recommend one and say why.
- **Method.** Use `product-ui-workbench` for the work and `design-quality-loop` to check it, when installed. Record each iteration: what changed, what the check found.
- **System.** Colors, type and spacing are tokens in one file; no hard-coded values in screens. Define every theme the product needs and check each.
- **Accessibility.** Contrast at least 4.5:1 for text, targets at least 44 px, readable sizes, states for empty / loading / error.
- **Honest limits.** State what was checked (which screens, which sizes, which themes) and what was not.
- **Done also means:** images or an HTML preview that the user can open, plus a one-page summary of decisions and open questions.
