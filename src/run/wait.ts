import type { RunManager } from './runner.ts';

/** Resolves when the run has ended; after `timeoutMs` the run is stopped and this resolves anyway. */
export function waitForRun(runs: RunManager, id: string, timeoutMs: number): Promise<void> {
  return new Promise((done) => {
    const un = runs.subscribe(id, (e) => { if (e.kind === 'end') { clearTimeout(t); un(); done(); } });
    const t = setTimeout(() => { runs.stop(id); un(); done(); }, timeoutMs);
    if (runs.get(id)?.outcome != null) { clearTimeout(t); un(); done(); }
  });
}
