const store = new Map();
export function remember(a, b, compute) {
  const key = a + b;
  if (!store.has(key)) store.set(key, compute(a, b));
  return store.get(key);
}
