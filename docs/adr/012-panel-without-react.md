# ADR-012: the panel is plain ES modules, no React, no bundler

Decision: `web/` is served as static files. A 100-line element builder (`h()`), a router on `location.hash`, and one module per view.
Why: zero build step and zero dependencies (ADR-010); strict CSP (`script-src 'self'`, no inline script); easy to read for agents.
Safety: no `innerHTML` with data anywhere (checked by `hub security`); markdown-lite renders to DOM nodes.
Consequence: if the UI outgrows this, a React/Vite build can replace `web/` without touching the API.
