// The timers of the context gauge, without any DOM so they can be tested with a fake clock (src/econ/context-review.test.ts).
// Rules: once stop() was called nothing can restart it (a late show() or refresh() is ignored, a late answer is dropped); a view that was on the
// page and left stops by itself; a view that is not mounted yet gets `grace` polls before it gives up; polling is every `liveMs` while a run works, else `idleMs`.
// Wrapped, not `{ setTimeout, ... }`: a browser throws "Illegal invocation" when window.setTimeout is called as a method of another object (found in the panel, not in node).
export const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };

export function gaugeController({ fetchModel, render, isConnected, timers = defaultTimers, liveMs = 4000, idleMs = 30000, tickMs = 15000, grace = 3 }) {
  let runId = null, m = null, at = 0, poll = null, tick = null, seq = 0, dead = false, seen = false, strikes = 0;
  const draw = () => render(m, at);
  function stop() {
    dead = true; seq++; runId = null;
    if (poll !== null) timers.clearTimeout(poll);
    if (tick !== null) timers.clearInterval(tick);
    poll = tick = null;
  }
  /** The page keeps the view mounted while it is on screen: leaving it ends the polling for good. */
  const gone = () => { if (isConnected()) { seen = true; strikes = 0; return false; } return seen || ++strikes > grace; };
  async function load() {
    if (dead || !runId) return;
    const id = runId, mine = ++seq;
    let next = null;
    try { next = await fetchModel(id); } catch { next = null; }
    if (dead || mine !== seq || id !== runId) return;   // stopped, or another thread was opened meanwhile
    m = next; at = Date.now(); draw();
    if (gone()) { stop(); return; }
    if (poll !== null) timers.clearTimeout(poll);
    poll = timers.setTimeout(load, m?.live ? liveMs : idleMs);
  }
  return {
    show(id) {
      if (dead || id === runId) return;
      runId = id || null; if (!runId) m = null;   // inside one thread the old reading stays until the new one arrives: no flicker
      seq++; if (poll !== null) timers.clearTimeout(poll); poll = null; draw();
      if (runId) load();
      if (tick !== null) timers.clearInterval(tick);
      tick = timers.setInterval(() => { if (dead) return; if (isConnected()) seen = true; else if (seen) { stop(); return; } if (m) draw(); }, tickMs);   // the tick only notices a view that LEFT; the grace is counted per poll   // the cache countdown keeps running between polls
    },
    refresh() { if (!dead && runId) load(); },
    stop,
  };
}
