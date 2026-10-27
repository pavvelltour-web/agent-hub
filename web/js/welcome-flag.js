// "The first-run steps were finished or skipped" flag. Stored in localStorage when it works; kept in memory for the session when it throws
// (private window, blocked site data), so "Пропустить всё" ends the redirect to /welcome instead of looping.
const KEY = 'hub.welcomeDone';
let memory = false;
export function welcomeDone() {
  if (memory) return true;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function markWelcomeDone() {
  memory = true;
  try { localStorage.setItem(KEY, '1'); } catch { /* the in-memory flag covers this session */ }
}
