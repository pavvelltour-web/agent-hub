// Test double for the claude / codex CLIs: reads the prompt from stdin, prints a scripted JSONL stream.
// Scenario comes from FAKE_SCENARIO; without it the scenario is derived from the CLI shape (codex has `exec`) and the prompt
// (“!limit” or “лимит” → usage-limit stop). FAKE_DEMO=1 gives slower, richer streams for `hub ui --demo`. Never used by real work.
// FAKE_SCENARIO=fixture:<name>.jsonl[+<name>.jsonl…] replays recorded CLI output line by line from src/adapters/fixtures/ (FAKE_FIXTURE_DELAY ms between lines, default 150).
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isCodex = process.argv.includes('exec');
let scenario = process.env.FAKE_SCENARIO;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) prompt += line + '\n';
prompt = prompt.trim();
// Review scenarios (src/review/agents.test.ts) are picked per call by a marker in the prompt: [[fake:review-json]].
if (!scenario) { const m = /\[\[fake:(review-[a-z-]+)\]\]/.exec(prompt); if (m) scenario = m[1]; }
if (!scenario) scenario = (process.env.FAKE_DEMO ? 'demo-' : '') + (/!limit|лимит/i.test(prompt) ? (isCodex ? 'codex-limit' : 'claude-limit') : (isCodex ? 'codex-ok' : 'claude-ok'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT_MSG = "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 27th, 2026 12:03 PM.";

if (scenario.startsWith('fixture:')) {
  // Only plain lower-case names ending in .jsonl: no separators, no `..` path, no drive letters, so nothing outside the fixtures folder can be read.
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const names = scenario.slice('fixture:'.length).split('+');
  const bad = names.find((n) => !/^[a-z0-9.-]+\.jsonl$/.test(n) || !existsSync(join(dir, n)));
  if (bad !== undefined) { process.stderr.write(`fake-agent: not a fixture name: ${JSON.stringify(bad)}\n`); process.exitCode = 2; }
  else {
    const delay = Number(process.env.FAKE_FIXTURE_DELAY ?? 150);
    for (const n of names) for (const line of readFileSync(join(dir, n), 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; process.stdout.write(line + '\n'); if (delay > 0) await sleep(delay); }
  }
} else if (scenario.startsWith('demo-')) {
  const codex = scenario.includes('codex');
  const limit = scenario.endsWith('limit');
  const ask = prompt.replace(/\s+/g, ' ').slice(0, 90);
  const say = (text) => (codex ? out({ type: 'item.completed', item: { type: 'agent_message', text } }) : out({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
  const tool = (name, command, res, code = 0) => {
    if (codex) out({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: res, exit_code: code } });
    else { out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { command } }] } }); out({ type: 'user', message: { content: [{ type: 'tool_result', content: res, is_error: code !== 0 }] } }); }
  };
  if (codex) { out({ type: 'thread.started', thread_id: 'demo-codex-' + Date.now() }); out({ type: 'turn.started' }); }
  else out({ type: 'system', subtype: 'init', session_id: 'demo-claude-' + Date.now(), model: 'claude-sonnet-5-5' });
  await sleep(500); say(`Принял задачу: «${ask}». Сначала посмотрю состояние проекта.`);
  await sleep(600); tool('Bash', 'git status --short', ' M src/core/hooks.ts\n?? src/core/hooks.test.ts');
  await sleep(600); say('План:\n\n1. Разобрать формат хуков Claude\n2. Сопоставить события с Codex\n3. Написать тест на **подстановку пути**\n\n```ts\nconst root = pluginRoot.replace(/\\\\/g, "/");\n```');
  await sleep(600); tool('Edit', 'src/core/hooks.ts', 'файл обновлён (+18 −3)');
  await sleep(600); tool('Bash', 'npm test', limit ? 'FAIL hooks: SessionStart keeps PLUGIN_ROOT' : 'pass 12, fail 0', limit ? 1 : 0);
  await sleep(500);
  if (limit) {
    if (codex) { out({ type: 'error', message: LIMIT_MSG }); out({ type: 'turn.failed', error: { message: LIMIT_MSG } }); process.exitCode = 1; }
    else out({ type: 'result', is_error: true, result: 'Claude usage limit reached', usage: { input_tokens: 10, output_tokens: 2 } });
  } else {
    say('Готово: хуки переносятся, тест зелёный. Изменения в `src/core/hooks.ts`.');
    if (codex) out({ type: 'turn.completed', usage: { input_tokens: 240000, cached_input_tokens: 210000, output_tokens: 4200 } });
    else out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 12000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 190000, output_tokens: 3100 }, total_cost_usd: 0.18 });
  }
} else if (scenario === 'cascade-script') {
  // Cascade (src/run/cascade.test.ts): FAKE_CASCADE_SCRIPT is a JSON file, an array with one step per call, in call order:
  // { git?: string[][], lockIndex?: true, write?: { <relative path>: <content> }, text?: string, login?: true, sleepMs?: number, ctx?: number }
  // (git: commands run in the cwd first; lockIndex: leave a git index.lock; `{{cwd}}` in a content is replaced by the cwd with forward slashes). Each call appends {argv, prompt, cwd} to FAKE_CAPTURE_FILE and writes the files into its cwd.
  const steps = JSON.parse(readFileSync(process.env.FAKE_CASCADE_SCRIPT, 'utf8'));
  const argv = process.argv.slice(2);
  const index = existsSync(process.env.FAKE_CAPTURE_FILE) ? readFileSync(process.env.FAKE_CAPTURE_FILE, 'utf8').split('\n').filter(Boolean).length : 0;
  appendFileSync(process.env.FAKE_CAPTURE_FILE, JSON.stringify({ argv, prompt, cwd: process.cwd() }) + '\n');
  const step = steps[index] ?? {};
  out({ type: 'system', subtype: 'init', session_id: `cascade-${index}`, model: 'claude-sonnet-5-5' });
  if (step.ctx) out({ type: 'assistant', message: { content: [{ type: 'text', text: 'reading a lot' }], usage: { input_tokens: 10, cache_read_input_tokens: step.ctx, output_tokens: 5 } } });   // a call whose prompt is `ctx` tokens
  if (step.sleepMs) await sleep(step.sleepMs);
  if (step.login) out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: { input_tokens: 0, output_tokens: 0 } });
  else {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    for (const a of step.git ?? []) spawnSync('git', a, { cwd: process.cwd() });
    for (const [rel, content] of Object.entries(step.write ?? {})) {
      const abs = join(process.cwd(), rel);
      if (!abs.startsWith(process.cwd())) throw new Error('fake-agent: path outside cwd');
      mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content.replaceAll('{{cwd}}', process.cwd().split('\\').join('/')));
    }
    if (step.lockIndex) { const gd = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim(); writeFileSync(join(gd, 'index.lock'), ''); }
    const text = step.text ?? `step ${index} done`;
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 } });
  }
} else if (scenario.startsWith('review-')) {
  // Review reviewers: one final assistant text holding the structured result, in the shape of the CLI that was started (claude / codex).
  // The real CLIs' structured-output shapes under --json-schema / --output-schema are UNVERIFIED; these are the documented/assumed ones.
  // FAKE_CAPTURE_FILE: append {argv, prompt, schemaFileExists} per call so tests can inspect what the hub started.
  const argv = process.argv.slice(2);
  if (process.env.FAKE_CAPTURE_FILE) {
    const si = argv.indexOf('--output-schema');
    appendFileSync(process.env.FAKE_CAPTURE_FILE, JSON.stringify({ argv, prompt, schemaFileExists: si >= 0 ? existsSync(argv[si + 1]) : null, hubEnv: Object.keys(process.env).filter((k) => /hub/i.test(k)), cwd: process.cwd(), cwdFiles: readdirSync(process.cwd()) }) + '\n');
  }
  const codexShape = isCodex || scenario === 'review-codex-json';
  const mi = Math.max(argv.indexOf('--model'), argv.indexOf('-m'));
  const model = mi >= 0 ? argv[mi + 1] : '';
  const findings = [
    { category: 'bug', file: 'src/a.ts', line: 12, title: 'Off-by-one in loop', evidence: 'for (let i = 0; i <= n; i++)', classOfBug: 'off-by-one: src/a.ts:12, src/b.ts:40' },
    { category: 'risk', file: 'src/b.ts', line: 7, title: 'Unchecked path join', evidence: 'join(root, name)', classOfBug: '' },
    { category: 'bug', file: 'src/c.ts', line: 3, title: 'Claim without evidence', evidence: '', classOfBug: '' },
    { category: 'bug', file: 'src/d.ts', title: 'Claim without a line', evidence: 'x', classOfBug: '' },
    { category: 'bug', line: 5, title: 'Claim without a file', evidence: 'x', classOfBug: '' },
  ];
  const real = scenario === 'review-verify-real' || (scenario === 'review-verify-by-model' && !String(model).includes('notreal'));
  // review-script (src/review/gate.test.ts): FAKE_REVIEW_SCRIPT is a JSON file { hunt: { <lens>: findings[] | "prose" }, verify: "real" | "notreal" }; the role and the lens are read from the prompt.
  let scripted;
  if (scenario === 'review-script') {
    const plan = JSON.parse(readFileSync(process.env.FAKE_REVIEW_SCRIPT, 'utf8'));
    if (prompt.includes('<<<DATA:finding:')) scripted = JSON.stringify({ real: plan.verify !== 'notreal', why: 'scripted verdict' });
    else {
      const lens = /security pass/i.test(prompt) ? 'security' : /Lens: edge cases/.test(prompt) ? 'edge-cases' : /Lens: intent/.test(prompt) ? 'intent' : /Lens: concurrency/.test(prompt) ? 'concurrency' : /Lens: UI/.test(prompt) ? 'ui' : 'correctness';
      const h = (plan.hunt ?? {})[lens] ?? [];
      scripted = h === 'prose' ? 'LGTM, nothing to fix.' : JSON.stringify({ summary: `${h.length} findings`, findings: h });
    }
  }
  const text = scripted !== undefined ? scripted : scenario === 'review-json' || scenario === 'review-codex-json' ? '```json\n' + JSON.stringify({ summary: '2 findings', findings }) + '\n```'
    : scenario === 'review-prose' ? 'LGTM, nothing to fix.'
    : scenario === 'review-bad' ? '{"summary": "1 finding", "findings": [{"category": "bug", "file": '
    : JSON.stringify({ real, why: real ? 'the loop bound reads one past the end: `i <= n`' : 'no evidence in the diff' });
  if (codexShape) { out({ type: 'thread.started', thread_id: 'review-codex' }); out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } }); out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }); }
  else { out({ type: 'system', subtype: 'init', session_id: 'review-claude', model: 'claude-opus-5-5' }); out({ type: 'assistant', message: { content: [{ type: 'text', text }] } }); out({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 } }); }
} else if (scenario === 'claude-summary') {
  out({ type: 'system', subtype: 'init', session_id: 'sum-1', model: 'claude-haiku-4-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '{"goal":"Implement T016 hooks","done":["wrote compiler"],"stoppedAt":"test SessionStart keeps PLUGIN_ROOT fails","next":["fix path substitution","run tests"],"open":["does Codex support PreToolUse?"]}' }] } });
  out({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 5, output_tokens: 5 } });
} else if (scenario === 'claude-limit') {
  out({ type: 'system', subtype: 'init', session_id: 'cl-limit' });
  out({ type: 'result', is_error: true, result: 'Claude usage limit reached', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'claude-ok') {
  // FAKE_ARGV_FILE: append {argv, mcp} per call: the CLI arguments and what the --mcp-config file held at that moment (lean tool sets, src/run/lean.test.ts).
  if (process.env.FAKE_ARGV_FILE) { const a = process.argv.slice(2), i = a.indexOf('--mcp-config'); appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({ argv: a, mcp: i >= 0 && existsSync(a[i + 1]) ? readFileSync(a[i + 1], 'utf8') : null }) + '\n'); }
  out({ type: 'system', subtype: 'hook_started', hook_id: 'x' });
  out({ type: 'system', subtype: 'init', session_id: 'fake-claude-1', model: 'claude-sonnet-5-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `got ${prompt.length} chars: ${prompt.slice(0, 40)}` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: '1 failing', is_error: true }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixed' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'fixed', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.01 });
} else if (scenario === 'claude-rich') {
  // Event model v2: thinking, a secret inside a tool input, a big tool output, an edit (diff), live partial text.
  const key = 'sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4';
  out({ type: 'system', subtype: 'init', session_id: 'rich-1', model: 'claude-sonnet-5-5' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } });
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan the change' }, { type: 'text', text: 'Working' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'deploy --token ' + key } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'row key ' + key + '\n' + 'line of output\n'.repeat(20000) }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'a.txt', old_string: 'one', new_string: 'two' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1500, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'claude-login') {
  out({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-4-5' });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: { input_tokens: 0, output_tokens: 0 } });
} else if (scenario === 'codex-limit') {
  out({ type: 'thread.started', thread_id: 'fake-codex-1' });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'working on T016' } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'FAIL hooks', exit_code: 1 } });
  out({ type: 'error', message: LIMIT_MSG });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. try again at Oct 27th, 2026 12:03 PM." } });
  process.exitCode = 1;
} else if (scenario === 'codex-ok') {
  out({ type: 'thread.started', thread_id: 'fake-codex-2' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'done' } });
  out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 60, reasoning_output_tokens: 20 } });
} else if (scenario === 'probe') {
  // Mode probe double: what a step does depends on the permission mode passed on the command line (claude: --permission-mode).
  const mode = process.argv[process.argv.indexOf('--permission-mode') + 1];
  const step = (name, input, ok, msg) => {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', content: msg, ...(ok ? {} : { is_error: true }) }] } });
  };
  out({ type: 'system', subtype: 'init', session_id: 'probe-' + mode, model: 'claude-sonnet-5-5' });
  step('Read', { file_path: 'a.txt' }, true, 'one');
  if (mode === 'plan') step('Write', { file_path: 'b.txt' }, false, "Claude requested permissions to write to b.txt, but you haven't granted it yet.");
  else { (await import('node:fs')).writeFileSync('b.txt', 'ok'); step('Write', { file_path: 'b.txt' }, true, 'File created'); }
  if (mode === 'plan') step('Bash', { command: 'git status' }, false, 'Permission to use Bash has been denied.');
  else step('Bash', { command: 'git status' }, true, 'On branch main');
  if (mode === 'bypassPermissions') step('WebFetch', { url: 'https://example.com' }, true, 'Example Domain');
  else if (mode === 'auto') step('WebFetch', { url: 'https://example.com' }, false, 'This command requires approval');
  else step('WebFetch', { url: 'https://example.com' }, false, 'Permission to use WebFetch has been denied.');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
} else if (scenario === 'claude-bigctx') {
  // A context that grows past the hub's limit (src/run/run.test.ts, ADR-018): per-call usage of 120K then 260K tokens. A continuation from a handoff card is small.
  // FAKE_BIGCTX_END=1: the run ends on its own; FAKE_BIGCTX_ALWAYS=1: the continuation grows too. Otherwise the run would go on for 60 s and the hub must stop it.
  const fresh = /Handoff card/.test(prompt) && !process.env.FAKE_BIGCTX_ALWAYS;
  const call = (cached, text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: 5 } } });
  out({ type: 'system', subtype: 'init', session_id: fresh ? 'bigctx-2' : 'bigctx-1', model: 'claude-sonnet-5-5' });
  if (fresh) call(5000, 'fresh start'); else { call(120000, 'working'); call(260000, 'working more'); }
  if (fresh || process.env.FAKE_BIGCTX_END) out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 20 }, total_cost_usd: 0.01 });
  else await sleep(60000);
} else if (scenario === 'claude-trace') {
  // Run trace and context gauge (src/run/trace.test.ts, src/econ/context.test.ts): three model calls (message ids m1..m3), the first split over two lines (the CLI writes one line per
  // content block, each with the message's usage), two tool calls with a pause before the result so that a duration can be measured. FAKE_TRACE_TURNS=N: N calls with no tools instead (cap test).
  // Shapes follow the Anthropic API; NOT seen on a signed-in CLI here.
  out({ type: 'system', subtype: 'init', session_id: 'trace-1', model: 'claude-sonnet-5-5' });
  const u = (i, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: 5, cache_read_input_tokens: cr, output_tokens: o });
  if (process.env.FAKE_TRACE_TURNS) {
    for (let i = 0; i < Number(process.env.FAKE_TRACE_TURNS); i++) out({ type: 'assistant', message: { id: 'bulk' + i, content: [{ type: 'text', text: 'x' }], usage: u(1, 100 + i, 1) } });
  } else {
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'plan' }], usage: u(10, 900, 10) } });
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }], usage: u(10, 900, 40) } });
    await sleep(150);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok\n'.repeat(50) }] } });
    out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'a.txt' } }], usage: u(12, 1000, 30) } });
    await sleep(60);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'no such file', is_error: true }] } });
    out({ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'done' }], usage: u(5, 1100, 20) } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, result: 'done', usage: { input_tokens: 27, cache_creation_input_tokens: 15, cache_read_input_tokens: 3000, output_tokens: 90 }, total_cost_usd: 0.05 });
} else if (scenario === 'slow') {
  out({ type: 'system', subtype: 'init', session_id: 'slow-1' });
  await sleep(60000);
} else if (scenario === 'crash') {
  process.stderr.write('boom: something broke\n');
  process.exitCode = 3;
}
