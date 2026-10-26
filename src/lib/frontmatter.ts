/** Minimal SKILL.md front-matter reader: `key: value` and folded/literal blocks (`>`/`|`). No YAML dependency. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv) continue;
    const key = kv[1] as string;
    let val = (kv[2] ?? '').trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const buf: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? '')) buf.push((lines[++i] ?? '').trim());
      val = buf.filter(Boolean).join(' ');
    }
    out[key] = val.replace(/^["']|["']$/g, '');
  }
  return out;
}
