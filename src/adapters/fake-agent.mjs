// Test double for the claude / codex CLIs: reads the prompt from stdin, prints a scripted JSONL stream.
// Scenario comes from FAKE_SCENARIO; without it the scenario is derived from the CLI shape (codex has `exec`) and the prompt
// (“!limit” or “лимит” → usage-limit stop). FAKE_DEMO=1 gives slower, richer streams for `hub ui --demo`. Never used by real work.
import { createInterface } from 'node:readline';

const isCodex = process.argv.includes('exec');
let scenario = process.env.FAKE_SCENARIO;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) prompt += line + '\n';
prompt = prompt.trim();
if (!scenario) scenario = (process.env.FAKE_DEMO ? 'demo-' : '') + (/!limit|лимит/i.test(prompt) ? (isCodex ? 'codex-limit' : 'claude-limit') : (isCodex ? 'codex-ok' : 'claude-ok'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT_MSG = "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 27th, 2026 12:03 PM.";

if (scenario.startsWith('demo-')) {
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
} else if (scenario === 'claude-summary') {
  out({ type: 'system', subtype: 'init', session_id: 'sum-1', model: 'claude-haiku-4-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '{"goal":"Implement T016 hooks","done":["wrote compiler"],"stoppedAt":"test SessionStart keeps PLUGIN_ROOT fails","next":["fix path substitution","run tests"],"open":["does Codex support PreToolUse?"]}' }] } });
  out({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 5, output_tokens: 5 } });
} else if (scenario === 'claude-limit') {
  out({ type: 'system', subtype: 'init', session_id: 'cl-limit' });
  out({ type: 'result', is_error: true, result: 'Claude usage limit reached', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'claude-ok') {
  out({ type: 'system', subtype: 'hook_started', hook_id: 'x' });
  out({ type: 'system', subtype: 'init', session_id: 'fake-claude-1', model: 'claude-sonnet-5-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `got ${prompt.length} chars: ${prompt.slice(0, 40)}` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: '1 failing', is_error: true }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixed' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'fixed', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.01 });
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
} else if (scenario === 'slow') {
  out({ type: 'system', subtype: 'init', session_id: 'slow-1' });
  await sleep(60000);
} else if (scenario === 'crash') {
  process.stderr.write('boom: something broke\n');
  process.exitCode = 3;
}
