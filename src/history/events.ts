import { stat } from 'node:fs/promises';
import { sanitizeEvent } from '../adapters/event-utils.ts';
import { readJsonl } from '../lib/jsonl.ts';
import type { HubEvent } from '../adapters/types.ts';
import type { StoredEvent } from '../run/runner.ts';

export interface EventPage { events: StoredEvent[]; next: number | null; moved?: boolean }

/**
 * Position of an event inside a source file: `lineStartByte * SLOT + index of the event within its line`.
 * It is stable (the same for a big read and for paged reads), needs no index and doubles as the event's `seq`.
 * `next` is the position of the first event NOT returned (null at the end of the file).
 */
export const SLOT = 1000;
export const MAX_PAGE = 1000;

const int = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : d);

/**
 * Read-only paging over a JSONL history file. STREAMS from the line the offset points at and stops as soon as `limit` events are
 * collected: the file is never loaded whole. A missing file means the conversation was moved or deleted. A directory (or anything
 * else that is not a regular file) is refused. Bad lines are skipped by the reader; `map` turns one parsed line into events.
 */
export async function pageEvents(path: string, o: { offset: number; limit: number }, map: (line: unknown) => HubEvent[]): Promise<EventPage> {
  const offset = Math.max(0, int(o.offset, 0)), limit = Math.min(MAX_PAGE, Math.max(1, int(o.limit, 200)));
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error('source is not a regular file');
    size = st.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { events: [], next: null, moved: true };
    throw e;
  }
  const events: StoredEvent[] = [];
  let lineStart = Math.floor(offset / SLOT), skip = offset % SLOT;
  for await (const { obj, endByte } of readJsonl(path, lineStart)) {
    let evs: HubEvent[] = [];
    try { evs = map(obj).slice(0, SLOT - 1).map(sanitizeEvent); } catch { /* a surprising line must not break the page */ }
    const ts = obj && typeof obj === 'object' && typeof (obj as { timestamp?: unknown }).timestamp === 'string' ? (obj as { timestamp: string }).timestamp : '';
    for (let i = skip; i < evs.length; i++) {
      if (events.length >= limit) return { events, next: lineStart * SLOT + i };
      const e = evs[i] as HubEvent;
      events.push({ seq: lineStart * SLOT + i, ts, kind: e.kind, data: e });
    }
    skip = 0; lineStart = endByte;
    if (events.length >= limit) return { events, next: endByte < size ? endByte * SLOT : null };
  }
  return { events, next: null };
}
