import { toast } from './ui.js';

async function call(method, path, body, quiet) {
  let r;
  try { r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json', 'x-hub-user-action': 'click' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { if (!quiet) toast('Нет связи с сервером hub. Он запущен?', 'err'); throw new Error('network'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = j.error || 'Ошибка ' + r.status; if (!quiet) toast(msg, 'err'); const e = new Error(msg); e.status = r.status; e.body = j; throw e; }
  return j;
}
export const api = {
  get: (p, quiet) => call('GET', p, null, quiet),
  post: (p, b, quiet) => call('POST', p, b || {}, quiet),
};
export const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };

/** Live run events. Returns close(). Reconnects are handled by passing the last seq as `after`. */
export function stream(runId, after, onEvent, onEnd) {
  const es = new EventSource(`/api/runs/${runId}/stream?after=${after}`);
  es.addEventListener('ev', (m) => onEvent(JSON.parse(m.data)));
  es.addEventListener('end', (m) => { onEvent(JSON.parse(m.data)); es.close(); onEnd?.(); });
  es.onerror = () => { es.close(); onEnd?.(); };
  return () => es.close();
}

// Preferences (theme/accent) live in the browser only.
const KEY = 'hub.prefs';
export const prefs = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } },
  set(patch) {
    const p = { ...this.get(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
    document.documentElement.dataset.theme = p.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.accent = p.accent === 'orange' ? 'orange' : 'green';
    document.documentElement.dataset.material = p.material === 'opaque' ? 'opaque' : '';
    return p;
  },
};
