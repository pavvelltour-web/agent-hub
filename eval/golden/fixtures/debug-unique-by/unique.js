export function uniqueBy(items, key) {
  const seen = new Set();
  const out = [];
  for (const it of items.reverse()) {
    const k = key(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}
