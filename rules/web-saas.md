## Rules for a web product (Web / SaaS)
- **Contracts first.** Define API shapes and the data model before UI. Validate every input on the server; check who may do what on every request, not only in the UI.
- **Secrets and keys.** Anything in the browser bundle is public. Keep keys on the server; commit `.env.example` with names only.
- **Data.** Migrations are written, reviewed and reversible. Never change production data from an agent session.
- **UI work.** Use `product-ui-workbench` and `design-quality-loop` when installed, then check in the rendered page, not only in code: desktop and 375 px width, light and dark theme if the product has both, keyboard focus, empty / loading / error states.
- **Accessibility.** Text contrast at least 4.5:1, touch targets at least 44 px, every control has a label, no information by color alone.
- **Performance.** No blocking request in the first render; lists are paginated; images are sized. Note any measured regression.
- **Tests.** Unit tests for logic, one end-to-end test per main user flow. A bug fix starts with a failing test.
- **Done for UI changes also means:** screenshots of changed screens attached to the report.
