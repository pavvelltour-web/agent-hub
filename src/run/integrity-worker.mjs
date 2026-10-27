// Test helper (src/run/integrity.test.ts): one writer process hammering the seal file of a shared folder. Usage: node integrity-worker.mjs <dir> <keyPrefix> <n>
const [dir, prefix, n] = process.argv.slice(2);
const { seal } = await import('./integrity.ts');
for (let i = 0; i < Number(n); i++) seal(dir, `${prefix}${i}`, `hash-${prefix}${i}`);
