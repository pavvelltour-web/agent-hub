import { open } from 'node:fs/promises';

export interface JsonlLine { obj: unknown; endByte: number }

/** Stream a JSONL file from `fromByte`. Handles multi-MB lines; bad lines are skipped; a partial last line is not consumed. */
export async function* readJsonl(path: string, fromByte = 0): AsyncGenerator<JsonlLine> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const chunk = Buffer.allocUnsafe(1 << 20);
    let pos = fromByte;
    let carry: Buffer[] = [];
    let carryLen = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] !== 0x0a) continue;
        carry.push(Buffer.from(chunk.subarray(start, i)));
        const line = Buffer.concat(carry).toString('utf8').trim();
        carry = []; carryLen = 0;
        start = i + 1;
        const endByte = pos + i + 1;
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; /* skip malformed line */ }
        yield { obj, endByte };
      }
      if (start < bytesRead) { carry.push(Buffer.from(chunk.subarray(start, bytesRead))); carryLen += bytesRead - start; }
      pos += bytesRead;
    }
    if (carryLen) {
      const line = Buffer.concat(carry).toString('utf8').trim();
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { return; /* partial tail is left for the next run */ }
      yield { obj, endByte: size };
    }
  } finally { await fh.close(); }
}
