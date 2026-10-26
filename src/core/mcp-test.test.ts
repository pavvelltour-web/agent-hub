import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeStdio, testProject } from './mcp-test.ts';

const dir = mkdtempSync(join(tmpdir(), 'hub-mcp-'));
const fakeServer = join(dir, 'server.mjs');
writeFileSync(fakeServer, `import { createInterface } from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
for await (const l of createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fake-mcp', version: '1.2.3' }, capabilities: {} } });
  if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } });
}`);

test('probeStdio completes the MCP handshake and counts tools; failures are reported, not thrown', async () => {
  assert.deepEqual(await probeStdio(process.execPath, [fakeServer], 8000), { server: 'fake-mcp 1.2.3', tools: 2 });
  assert.match((await probeStdio(process.execPath, ['-e', 'process.exit(0)'], 8000)).error ?? '', /exited/);
  assert.match((await probeStdio('npx.cmd', ['x'])).error ?? '', /shim/);
  assert.ok((await probeStdio(join(dir, 'missing-binary'), [])).error);
});

test('testProject: never starts commands without consent; remote servers are not probed', async () => {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [fakeServer] }, mobbin: { type: 'http', url: 'https://api.mobbin.com/mcp' } } }));
  const dry = await testProject(dir, false);
  assert.deepEqual(dry.map((r) => [r.name, r.status]), [['local', 'unprobeable'], ['mobbin', 'remote']]);
  const live = await testProject(dir, true);
  assert.equal(live.find((r) => r.name === 'local')?.status, 'ok'); assert.match(live.find((r) => r.name === 'local')?.detail ?? '', /fake-mcp 1\.2\.3, 2 tools/);
  assert.deepEqual(await testProject(mkdtempSync(join(tmpdir(), 'hub-mcp-')), true), []);
});
