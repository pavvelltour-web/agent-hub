import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { readText } from './plan.ts';
import { join } from 'node:path';

export interface ProbeResult { name: string; status: 'ok' | 'remote' | 'unprobeable' | 'failed'; detail: string }
interface Server { command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string> }

/** Minimal MCP handshake over stdio: initialize → tools/list. Runs the configured command, so callers must have the user's consent. */
export function probeStdio(command: string, args: string[], timeoutMs = 20_000): Promise<{ server?: string; tools?: number; error?: string }> {
  return new Promise((resolve) => {
    const onlyShim = process.platform === 'win32' && !/\.\w+$/.test(command) && !(process.env['PATH'] ?? '').split(delimiter).some((d) => existsSync(join(d, command + '.exe'))) && (process.env['PATH'] ?? '').split(delimiter).some((d) => existsSync(join(d, command + '.cmd')));
    if (onlyShim || /\.(cmd|bat)$/i.test(command)) return resolve({ error: 'Windows .cmd shim cannot be started without a shell; verify inside the agent (/mcp)' });
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { return resolve({ error: (e as Error).message }); }
    let server: string | undefined, settled = false;
    const done = (r: { server?: string; tools?: number; error?: string }): void => { if (settled) return; settled = true; clearTimeout(t); child.kill(); resolve(r); };
    const t = setTimeout(() => done({ error: `no answer within ${timeoutMs / 1000}s` }), timeoutMs);
    const send = (o: object): void => void child.stdin.write(JSON.stringify(o) + '\n');
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', () => done({ error: 'process exited before answering' }));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: { id?: number; result?: { serverInfo?: { name?: string; version?: string }; tools?: unknown[] }; error?: { message?: string } };
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        if (m.error) return done({ error: m.error.message ?? 'initialize failed' });
        server = `${m.result?.serverInfo?.name ?? '?'} ${m.result?.serverInfo?.version ?? ''}`.trim();
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      } else if (m.id === 2) done({ ...(server ? { server } : {}), tools: m.result?.tools?.length ?? 0 });
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-hub', version: '0.1.0' } } });
  });
}

/** Test the servers in a project's `.mcp.json`. `allowRun` = the user agreed to start the configured commands. */
export async function testProject(root: string, allowRun: boolean): Promise<ProbeResult[]> {
  const raw = readText(join(root, '.mcp.json'));
  if (!raw) return [];
  const servers = (JSON.parse(raw) as { mcpServers?: Record<string, Server> }).mcpServers ?? {};
  const out: ProbeResult[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s.url) { out.push({ name, status: 'remote', detail: `remote ${s.url}: sign-in (OAuth) happens inside the agent; not probed here` }); continue; }
    if (!s.command) { out.push({ name, status: 'failed', detail: 'no command in config' }); continue; }
    if (!allowRun) { out.push({ name, status: 'unprobeable', detail: `would start: ${s.command} ${(s.args ?? []).join(' ')} (add --yes to allow)` }); continue; }
    const r = await probeStdio(s.command, s.args ?? []);
    out.push(r.error ? { name, status: /shim|shell/.test(r.error) ? 'unprobeable' : 'failed', detail: r.error } : { name, status: 'ok', detail: `${r.server}, ${r.tools} tools` });
  }
  return out;
}
