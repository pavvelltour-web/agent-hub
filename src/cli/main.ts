import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { authStatus } from '../adapters/auth.ts';
import { probeModes } from '../adapters/probe.ts';
import { detectAgents } from '../adapters/locate.ts';
import { loadTasks, parsePicks, runBench, summarize } from '../bench/bench.ts';
import { applyPlan, describe, listBackups, undoBackup, effective } from '../core/plan.ts';
import { classifyHooks } from '../core/hooks.ts';
import { adoptHooks } from '../core/hooks-adopt.ts';
import { compileAll } from '../core/compilers.ts';
import { planInit } from '../core/init.ts';
import { planInstall } from '../core/install.ts';
import { auditLoading, compileProfile, skillInfoFrom, type SkillState } from '../core/loading.ts';
import { addSkillRoot, HUB_HOME, library, loadUserConfig, removeSkillRoot, REPO_ROOT } from '../core/registry.ts';
import { scout } from '../core/scout.ts';
import { fetchAitmpl, searchGithub } from '../core/scout-remote.ts';
import { planLibraryInstall, previewComponent } from '../core/install-remote.ts';
import type { AgentId, Plan, RegistryEntry } from '../core/types.ts';
import { testProject } from '../core/mcp-test.ts';
import { pushGuardEnv } from '../run/git.ts';
import { build, check, KINDS, render, type Format, type Kind } from '../diagram/index.ts';
import { advise, ROUTING, type TaskClass } from '../econ/advisor.ts';
import { calibrate, estimate, modelStats, profileFromHistory } from '../econ/econ.ts';
import { syncClaude } from '../history/claude.ts';
import { syncCodex } from '../history/codex.ts';
import { listProjects, listSessions, openDb, search } from '../history/store.ts';
import { RunManager } from '../run/runner.ts';
import { approveRunnerHooks, readRunnerHooks } from '../run/hooks-run.ts';
import { startServer } from '../server/server.ts';
import { caseSummary, compareEval, evalReviewer, loadCases, readBaseline, writeBaseline } from '../review/eval.ts';
import { usableAgents } from '../review/gate.ts';
import { approveStage, stageStatus } from '../stages/engine.ts';

interface Args { _: string[]; flags: Record<string, string | true> }
const BOOL = new Set(['demo', 'yes', 'no-open', 'check', 'write', 'worktree', 'help', 'version', 'full', 'plan', 'dry', 'modes', 'compare', 'save-baseline']);
function parse(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t.startsWith('--')) { const k = t.slice(2); if (BOOL.has(k) || i + 1 >= argv.length || (argv[i + 1] as string).startsWith('--')) a.flags[k] = true; else a.flags[k] = argv[++i] as string; }
    else if (t === '-y') a.flags['yes'] = true;
    else a._.push(t);
  }
  return a;
}
const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
const out = (s = ''): void => void process.stdout.write(s + '\n');
const fail = (s: string, code = 1): never => { process.stderr.write(`hub: ${s}\n`); process.exit(code); };

const HELP = `agent-hub — one hub for coding agents (Claude Code, Codex, …)

Project
  hub init [path] [--type web-saas|mobile-app|automation|design-study] [--add id,id] [--remove skill/x] [--yes]
  hub undo [path] [backupId]            restore files from a backup made by init/add
  hub stage [path] [approve N]          lifecycle stages and gates
  hub scout [path] --brief "text" [--source local|aitmpl|github]   propose skills/MCP (never installs)
  hub get aitmpl/skills/<cat>/<name> [--yes]   fetch a skill/MCP into the hub library after a full preview (costs 0 tokens until linked)
  hub install [path] [--yes]            re-create links/MCP from hub.lock.json on a fresh clone (refuses changed sources)
  hub tools [path]                      what loads into every turn of the project (skills, plugins, MCP) with token cost
  hub profile [path] --off a,b [--name-only c] [--plugin-off id] [--on d]   trim that for this project only (plan + approval)
  hub config [list|add-skill-root <dir>|remove-skill-root <dir>]   extra folders scanned for skills
  hub mcp add <id> [path] [--yes]       add an MCP server from the library to Claude and Codex configs
  hub mcp test [path] [--yes]           MCP handshake with each stdio server (starts third-party commands only with --yes)
  hub open <claude|codex> [path]        native interactive UI in the project folder (git push blocked)
  hub hooks <hooks.json> [--plugin-root dir] [--adopt [project]]   map a Claude plugin's hooks to Codex; --adopt runs them from the hub runner
  hub hooks --approve [project]          approve runner hooks found in hub.json (they never run before you do)
Work
  hub chat [path] [--agent auto|claude|codex] [--model m] [--effort e]
  hub run "prompt" [path] [--agent …] [--class implement|plan|debug|review|mechanical|summary] [--task T016 --worktree] [--plan|--full]
  hub estimate --class implement|plan|debug|review|mechanical [--scale 2]
  hub bench [--picks sonnet:high,gpt-6.1-sol:medium] [--repeat N] [--dry]   golden tasks → solved count and cost per solved task (--dry lists the tasks only)
History
  hub sync                              import Claude + Codex history (read-only)
  hub history <query> [--agent claude|codex]    full-text search across agents
  hub sessions [--project slug]
Panel and checks
  hub ui [--port N] [--no-open] [--demo]  local panel on 127.0.0.1; --demo uses scripted fake agents (dev only: --token T fixes the token, --home DIR uses another data folder)
  hub diagram <${KINDS.join('|')}> [--format ascii|mermaid|json] [--entity t] [--check|--write] [path]
  hub review-eval [--effort quick|standard|deep] [--compare] [--save-baseline] [--dry]   runs the reviewers on eval/review cases: recall, noise, rounds (real reviewers: needs a signed-in CLI; --dry lists the cases only)
  hub doctor [--modes [--agent claude|codex]]   environment check; --modes measures what each permission mode allows (short real runs)
  hub security                          dependency/secret/code checks
`;

async function confirm(q: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) { out('(not a terminal: showing the plan only; add --yes to apply)'); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

const projectArg = (a: Args, i: number): string => resolve(a._[i] ?? process.cwd());

async function cmdInit(a: Args): Promise<void> {
  const root = projectArg(a, 1);
  const plan = planInit(root, { type: flag(a, 'type') ?? 'web-saas', extra: (flag(a, 'add') ?? '').split(',').filter(Boolean), remove: (flag(a, 'remove') ?? '').split(',').filter(Boolean) });
  out(`Plan for ${root} — nothing is written until you confirm:`);
  describe(plan).forEach((l) => out('  ' + l));
  plan.notes.forEach((n) => out('  ! ' + n));
  if (!plan.changes.length) return out('Nothing to change: already up to date.');
  if (await confirm('Apply these changes?', a.flags['yes'] === true)) { const r = applyPlan(plan, { approved: true }); out(`Done: ${r.written.length} files. Backup: ${r.backupId}  (undo: hub undo ${root} ${r.backupId})${r.fallbacks.length ? `\n  note: ${r.fallbacks.length} links were copied (junctions unavailable)` : ''}`); }
  else out('Not applied.');
}

/** Show a plan, ask, apply with backup. Shared by install / profile / hooks --adopt. */
async function showAndApply(plan: Plan, root: string, a: Args, question: string): Promise<boolean> {
  describe(plan).forEach((l) => out('  ' + l));
  plan.notes.forEach((n) => out('  ! ' + n));
  if (!plan.changes.length) { out('Nothing to change.'); return false; }
  if (await confirm(question, a.flags['yes'] === true)) { const r = applyPlan(plan, { approved: true }); out(`Done: ${r.written.length} files. Backup: ${r.backupId}  (undo: hub undo ${root} ${r.backupId})`); return true; }
  out('Not applied.'); return false;
}

/** Fetch a catalog skill/MCP into the hub library (never into an agent's global folder), after showing everything. */
async function cmdGet(a: Args): Promise<void> {
  const id = a._[1];
  if (!id) return fail('usage: hub get aitmpl/skills/<category>/<name> [--yes]   (find ids with: hub scout --source aitmpl --brief "...")');
  const pv = await previewComponent(id);
  out(`${pv.kind} ${pv.name}  license: ${pv.license}  scan: ${pv.scan ? `${pv.scan.severity} (${pv.scan.tool})` : 'none in catalog'}${pv.runsCode ? '  RUNS CODE' : ''}`);
  pv.files.forEach((f) => out(`  file ${f.path} (${f.size} chars)`));
  if (pv.blocked) return fail(`refused: ${pv.blocked}`);
  out('--- SKILL.md / config (first 40 lines) ---'); out(pv.text.split('\n').slice(0, 40).join('\n'));
  const plan = planLibraryInstall(pv);
  plan.notes.forEach((n) => out('  ! ' + n));
  await showAndApply(plan, HUB_HOME, a, 'Add to the hub library (not linked to any project)?');
}

async function cmdInstall(a: Args): Promise<void> {
  const root = projectArg(a, 1);
  const { plan, items } = planInstall(root);
  items.forEach((i) => out(`${({ ok: '✔', 'hash-changed': '✖', 'missing-source': '✖', 'not-in-library': '·' })[i.status]} ${i.id.padEnd(24)} ${i.detail}`));
  await showAndApply(plan, root, a, 'Create these links and settings?');
}

/** What loads into every turn of this project, per agent; the cheapest wins first. */
function cmdTools(a: Args): void {
  const root = projectArg(a, 1);
  const au = auditLoading(root);
  for (const ag of ['claude', 'codex'] as AgentId[]) {
    const t = au.totals[ag];
    out(`${ag}: ≈ ${t.now} tokens/turn now (${t.baseline} without this project's profile)${t.cap ? `  [list capped at ~${t.cap}]` : ''}`);
    au.rows.filter((r) => r.agent === ag && r.kind !== 'mcp' && (r.tokens ?? 0) + r.baseTokens > 0).sort((x, y) => y.baseTokens - x.baseTokens).slice(0, Number(flag(a, 'top') ?? 15))
      .forEach((r) => out(`  ${r.state.padEnd(9)} ${r.kind.padEnd(6)} ${r.name.padEnd(34)} ${String(r.baseTokens).padStart(5)} tok  ${r.origin}${r.switchable ? '' : ' (not switchable here)'}`));
    au.rows.filter((r) => r.agent === ag && r.kind === 'mcp').forEach((r) => out(`  mcp       ${r.name}  (${r.detail})`));
  }
  au.notes.forEach((n) => out('! ' + n));
  out('Change for this project only: hub profile [path] --off skillA,skillB --name-only skillC --plugin-off id@market --on skillD');
}

async function cmdProfile(a: Args): Promise<void> {
  const root = projectArg(a, 1);
  const list = (k: string): string[] => (flag(a, k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const skills: Record<string, SkillState> = {};
  for (const n of list('off')) skills[n] = 'off';
  for (const n of list('name-only')) skills[n] = 'name-only';
  for (const n of list('on')) skills[n] = 'on';
  const plugins: Record<string, boolean> = {};
  for (const n of list('plugin-off')) plugins[n] = false;
  for (const n of list('plugin-on')) plugins[n] = true;
  if (!Object.keys(skills).length && !Object.keys(plugins).length) return cmdTools(a);
  const plan = effective({ root, changes: compileProfile(root, { skills, plugins }, skillInfoFrom(library(root))), notes: ['Codex: a project-level override of skills/plugins is not verified; Claude follows its documented skillOverrides / enabledPlugins.'] });
  await showAndApply(plan, root, a, 'Write the project tool profile?');
}

async function cmdHooks(a: Args): Promise<void> {
  if (a.flags['approve'] !== undefined) {
    const root = resolve(flag(a, 'approve') ?? process.cwd());
    const h = readRunnerHooks(root);
    if (!h.sessionStart.length && !h.sessionEnd.length) return out('No runner hooks in hub.json.');
    h.sessionStart.forEach((c) => out(`sessionStart: ${c.join(' ')}`)); h.sessionEnd.forEach((c) => out(`sessionEnd:   ${c.join(' ')}`));
    if (h.approved) return out('Already approved on this machine.');
    out('These commands will run on this computer around every agent session in the project.');
    if (await confirm('Approve them?', a.flags['yes'] === true)) { approveRunnerHooks(root); out('Approved.'); } else out('Not approved: they stay skipped.');
    return;
  }
  const f = a._[1];
  if (!f) return fail('usage: hub hooks <hooks.json> [--plugin-root dir] [--adopt [project]] [--yes]   |   hub hooks --approve [project]');
  const reports = classifyHooks(readFileSync(f, 'utf8'), flag(a, 'plugin-root') ?? resolve(f, '..', '..'));
  if (a.flags['adopt'] === undefined) return reports.forEach((h) => out(`${h.event.padEnd(18)} ${h.codex.padEnd(11)} ${h.notes.join(' · ')}`));
  const root = resolve(flag(a, 'adopt') ?? process.cwd());
  const r = adoptHooks(root, reports);
  r.adopted.forEach((x) => out(`+ ${x.event} → runner ${x.as}: ${x.argv.join(' ')}`));
  r.skipped.forEach((x) => out(`- ${x.event} skipped: ${x.why}`));
  if (await showAndApply(r.plan, root, a, 'Write these runner hooks into hub.json (and approve them to run here)?')) approveRunnerHooks(root);
}

async function cmdScout(a: Args): Promise<void> {
  const brief = flag(a, 'brief') ?? ''; const type = flag(a, 'type') ?? 'web-saas';
  const src = flag(a, 'source') ?? 'local';
  let lib: RegistryEntry[];
  if (src === 'aitmpl') lib = await fetchAitmpl((flag(a, 'kind') ?? 'skills') as 'skills');
  else if (src === 'github') lib = searchGithub(brief || fail('--source github needs --brief "search words"'));
  else { const root = projectArg(a, 1); lib = library(existsSync(root) ? root : undefined); }
  scout(lib, { brief, projectType: type, limit: 15, keepAll: src !== 'local' }).forEach((c) => out(`${c.score.toFixed(1).padStart(5)}  ${c.entry.id.padEnd(34)} ${String(c.entry.tokenCost).padStart(4)} tok  ${c.entry.license ?? 'unknown'}  — ${c.reasons.join('; ')}${c.entry.installCommand ? `\n         install (not run): ${c.entry.installCommand}` : ''}`));
  if (src !== 'local') out('\nThese are proposals from an outside catalog (unverified). Read the source and license before installing.');
}

function cmdConfig(a: Args): void {
  const sub = a._[1];
  if (sub === 'add-skill-root' && a._[2]) { addSkillRoot(a._[2]); return out(`Added. Skills there will appear in the library.`); }
  if (sub === 'remove-skill-root' && a._[2]) { removeSkillRoot(a._[2]); return out('Removed.'); }
  if (sub === 'list' || !sub) { const c = loadUserConfig(); out(`config: ${join(HUB_HOME, 'config.json')}`); (c.extraSkillRoots ?? []).forEach((r) => out(`  skill root: ${r}`)); if (!(c.extraSkillRoots ?? []).length) out('  (no extra skill roots)'); return; }
  fail('usage: hub config [list] | add-skill-root <dir> | remove-skill-root <dir>');
}

async function cmdMcp(a: Args): Promise<void> {
  if (a._[1] === 'list') { library().filter((e) => e.kind === 'mcp').forEach((e) => out(`${e.id.padEnd(22)} ${e.sourceVerified ? '✔' : '? unverified'}  ${e.title} — ${e.description}`)); return; }
  if (a._[1] === 'test') {
    const root = projectArg(a, 2);
    const res = await testProject(root, a.flags['yes'] === true);
    if (!res.length) return out('No .mcp.json servers in this project.');
    res.forEach((r) => out(`${({ ok: '✔', remote: '↗', unprobeable: '·', failed: '✖' })[r.status]} ${r.name.padEnd(16)} ${r.detail}`));
    if (res.some((r) => r.status === 'unprobeable') && a.flags['yes'] !== true) out('(servers are started only with --yes: they are third-party commands)');
    return;
  }
  if (a._[1] !== 'add' || !a._[2]) return fail('usage: hub mcp add <id> [path] [--yes] | hub mcp test [path] [--yes]   (see: hub mcp list)');
  const root = projectArg(a, 3);
  const e = library(root).find((x) => x.id === (a._[2]?.includes('/') ? a._[2] : `mcp/${a._[2]}`));
  if (!e || e.kind !== 'mcp') return fail(`no MCP "${a._[2]}" in the library`);
  const plan = effective({ root, changes: compileAll(root, [e]).filter((c) => /\.mcp\.json$|config\.toml$/.test(c.path)), notes: [] });
  out(`${e.title}: ${e.mcp?.url ? `remote ${e.mcp.url}` : `${e.mcp?.command} ${(e.mcp?.args ?? []).join(' ')}`}  | network: ${e.risk.network}  runs code: ${e.risk.executesCode}  verified: ${e.sourceVerified}`);
  if (e.mcp?.url) out('  OAuth happens inside the agent on first use; no secret is written to files.');
  describe(plan).forEach((l) => out('  ' + l));
  if (!plan.changes.length) return out('Already configured.');
  if (await confirm('Write these MCP settings?', a.flags['yes'] === true)) { const r = applyPlan(plan, { approved: true }); out(`Done. Backup: ${r.backupId}. Verify inside the agent: /mcp (Claude) or restart Codex.`); }
}

async function cmdRun(a: Args, chat: boolean): Promise<void> {
  const db = openDb();
  const rm = new RunManager(db);
  const root = projectArg(a, chat ? 1 : 2);
  const agent = (flag(a, 'agent') ?? 'auto') as AgentId | 'auto';
  const stateOf = (): ReturnType<typeof advise> => advise({ cls: ((flag(a, 'class') ?? 'implement') in ROUTING ? flag(a, 'class') ?? 'implement' : 'implement') as TaskClass, stats: modelStats(db), limits: {} });
  let prev: string | undefined;
  const once = async (prompt: string): Promise<void> => {
    const ch = agent === 'auto' ? stateOf() : undefined;
    const ag = (agent === 'auto' ? (ch as ReturnType<typeof advise>).agent : agent) as AgentId;
    if (ch) out(`[auto → ${ag} ${ch.model} ${ch.effort}: ${ch.reason}]`);
    const run = rm.start({ agent: ag, prompt, projectRoot: root, ...(flag(a, 'model') ?? ch?.model ? { model: (flag(a, 'model') ?? ch?.model) as string } : {}), ...(flag(a, 'effort') ?? ch?.effort ? { effort: (flag(a, 'effort') ?? ch?.effort) as string } : {}), permission: a.flags['full'] ? 'full' : a.flags['plan'] ? 'plan' : 'edit', mode: a.flags['worktree'] ? 'task' : 'chat', cls: ((flag(a, 'class') ?? 'implement') in ROUTING ? flag(a, 'class') ?? 'implement' : 'implement'), ...(flag(a, 'task') ? { task: flag(a, 'task') as string } : {}), ...(prev ? { resumeRunId: prev } : {}) });
    await new Promise<void>((done) => {
      const un = rm.subscribe(run.id, (e) => {
        const d = e.data as { text?: string; name?: string; summary?: string; message?: string; reached?: boolean };
        if (e.kind === 'text') out(d.text ?? '');
        else if (e.kind === 'tool') out(`  ⚙ ${d.name}: ${d.summary}`);
        else if (e.kind === 'tool_result' && d.summary) out(`    ↳ ${d.summary.slice(0, 120)}`);
        else if (e.kind === 'error') out(`  ✖ ${d.message}`);
        else if (e.kind === 'limit') out(`  ⚠ limit: ${d.message}`);
        else if (e.kind === 'warn' && !String(d.message).startsWith('handoff_ready')) out(`  ! ${d.message}`);
        else if (e.kind === 'end') { un(); done(); }
      });
      if (!rm.isLive(run.id)) { un(); done(); }
    });
    const r = rm.get(run.id) as NonNullable<ReturnType<RunManager['get']>>;
    prev = r.sessionNativeId ? run.id : prev;
    out(`— ${r.outcome} · ${r.agent}${r.model ? ' ' + r.model : ''} · tokens in ${r.tokensIn ?? '?'} out ${r.tokensOut ?? '?'}${r.costUsd != null ? ` · $${r.costUsd.toFixed(3)}` : ''}`);
    if (r.outcome === 'limit') { const c = rm.handoffCard(run.id); if (c) out(`  Handoff card: ${c.path}\n  Continue elsewhere: hub run "continue" --agent ${ag === 'claude' ? 'codex' : 'claude'}   (or press "Передать" in the panel)`); }
  };
  if (!chat) { const p = a._[1]; if (!p) return fail('usage: hub run "prompt" [path]'); await once(p); return; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  out(`hub chat in ${root} (agent: ${agent}). Empty line or /exit to quit.`);
  for (;;) { const l = (await rl.question('› ')).trim(); if (!l || l === '/exit') break; await once(l); }
  rl.close();
}

async function cmdModes(a: Args, ag: ReturnType<typeof detectAgents>): Promise<void> {
  const ids = (flag(a, 'agent') ? [flag(a, 'agent') as AgentId] : (['claude', 'codex'] as AgentId[])).filter((id) => id === 'claude' || id === 'codex');
  const runs = new RunManager(openDb(':memory:'));   // probe runs must not become projects/history in the real index, nor mark panel runs as interrupted
  for (const id of ids) {
    if (!ag[id].installed) { out(`${id}: CLI not found, skipped`); continue; }
    if (authStatus(id, ag[id]).loggedIn === false) { out(`${id}: not signed in: sign in first, then repeat`); continue; }
    out(`${id}: probing plan, edit, full (three short real runs in a temp folder; this uses a little of your limit)…`);
    const m = await probeModes({ agent: id, runs, cliVersion: ag[id].version ?? null, ...(id === 'claude' ? { model: 'haiku' } : {}) });
    if (Object.values(m).every((r) => Object.values(r).every((v) => v === 'unknown'))) { out(`  nothing could be classified (the CLI wording is not recognised yet): matrix not saved`); continue; }
    for (const [mode, row] of Object.entries(m)) out(`  ${mode.padEnd(5)} read ${row.read.padEnd(8)} write ${row.write.padEnd(8)} shell ${row.shell.padEnd(8)} network ${row.network}`);
  }
}

async function cmdBench(a: Args): Promise<void> {
  const tasks = loadTasks(join(REPO_ROOT, 'eval', 'golden'));
  if (a.flags['dry']) return tasks.forEach((t) => out(`${t.id.padEnd(26)} ${t.cls.padEnd(11)} verify: ${t.verify.join(' ')}`));
  let picks; try { picks = parsePicks(flag(a, 'picks') ?? 'sonnet:high'); } catch (e) { return fail((e as Error).message); }
  const ag = detectAgents();
  for (const id of new Set(picks.map((p) => p.agent))) {
    if (!ag[id].installed) return fail(`${id} CLI not found (hub doctor)`);
    if (authStatus(id, ag[id]).loggedIn === false) return fail(`${id} is not signed in: sign in first (run \`${id === 'claude' ? 'claude' : 'codex login'}\`), then repeat`);
  }
  const rows = await runBench({ tasks, picks, runs: new RunManager(openDb(':memory:')), repeat: Math.max(1, Number(flag(a, 'repeat') ?? 1) || 1) });
  rows.forEach((r) => out(`${r.taskId.padEnd(26)} ${r.agent}:${r.model}:${r.effort}  ${r.solved ? 'solved' : 'unsolved'}  ${r.costUsd != null ? '$' + r.costUsd.toFixed(3) : '$?'}  ${r.seconds}s`));
  out('');
  summarize(rows).forEach((s) => out(`${s.pick.padEnd(28)} solved ${s.solved}/${rows.filter((r) => `${r.agent}:${r.model}:${r.effort}` === s.pick).length}  cost per solved ${s.costPerSolved != null ? '$' + s.costPerSolved.toFixed(3) : 'n/a'}  limit % per solved ${s.pctPerSolved ?? 'n/a'}`));
}

async function cmdReviewEval(a: Args): Promise<void> {
  const e = a.flags['effort'];
  if (e !== undefined && e !== 'quick' && e !== 'standard' && e !== 'deep') return fail('--effort must be quick, standard or deep');
  const effort = e ?? 'standard';
  const dir = join(REPO_ROOT, 'eval', 'review');
  const skipped: string[] = [];
  const cases = loadCases(dir, skipped);
  skipped.forEach((s) => out(`skipped case ${s}`));
  if (!cases.length) return fail(`no review cases in ${dir}`);
  if (a.flags['dry']) {
    cases.forEach((c) => out(`${c.id.padEnd(26)} ${c.kind.padEnd(6)} ${(c.source ?? '-').padEnd(9)} ${c.bugs.map((b) => `${b.file}:${b.line}`).join(', ') || '-'}`));
    const n = caseSummary(dir);
    return out(`${n.total} cases: ${n.buggy} buggy, ${n.clean} clean (${n.seed} seed, ${n.incident} incident)`);
  }
  const basePath = join(HUB_HOME, 'review-eval-baseline.json');
  const base = a.flags['compare'] ? readBaseline(basePath) : null;
  if (a.flags['compare'] && !base) return fail(`no baseline saved yet (${basePath}): run once with --save-baseline, then repeat`);
  const { available, warnings } = usableAgents();   // installed + signed in, the same check as hub bench: no review is started without it
  if (!available.length) return fail(`no usable reviewer: sign in first (run \`claude\` or \`codex login\`), then repeat (${warnings.join('; ') || 'none found'})`);
  warnings.forEach((w) => out(`note: ${w}`));
  out(`running ${cases.length} cases at "${effort}" with ${available.join(' + ')}: this spends real limit (each buggy case takes at least 2 rounds)`);
  const r = await evalReviewer({ cases, effort, runs: new RunManager(openDb(':memory:')), available, db: openDb() });
  r.cases.forEach((c) => out(`${c.id.padEnd(26)} ${c.kind.padEnd(6)} ${c.kind === 'buggy' ? `found ${c.found}/${c.bugs}` : `flagged ${c.blocking}`}  rounds ${c.rounds}`));
  out('');
  out(`recall ${Math.round(r.recall * 100)}%   noise per clean case ${r.noiseOnClean.toFixed(2)}   rounds ${r.roundsToPass.toFixed(2)}`);
  out(`answers to real findings: ${Object.entries(r.byAnswer).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (base) {
    const c = compareEval(base, r);
    out(`baseline (${base.savedAt.slice(0, 10)}, ${base.effort}): recall ${Math.round(base.recall * 100)}%   noise ${base.noiseOnClean.toFixed(2)}   rounds ${base.roundsToPass.toFixed(2)}`);
    if (!c.ok) return fail(c.why);
    out('recall did not drop');
  }
  if (a.flags['save-baseline']) { writeBaseline(basePath, { recall: r.recall, noiseOnClean: r.noiseOnClean, roundsToPass: r.roundsToPass, effort, cases: cases.length, savedAt: new Date().toISOString() }); out(`baseline saved: ${basePath}`); }
}

async function cmdUi(a: Args): Promise<void> {
  const db = openDb();
  const fakeAgent = join(REPO_ROOT, 'src', 'adapters', 'fake-agent.mjs');
  const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
  if (a.flags['demo']) { process.env['FAKE_DEMO'] = '1'; out('DEMO MODE: agents are scripted fakes (no limits are spent). Put “лимит” or “!limit” in a message to see a limit stop and handoff.'); }
  const s = await startServer({ db, runs: new RunManager(db, a.flags['demo'] ? { exe: { claude: fakeExe, codex: fakeExe } } : {}) }, { ...(flag(a, 'port') ? { port: Number(flag(a, 'port')) } : {}), ...(flag(a, 'token') ? { token: flag(a, 'token') as string } : {}) });
  out(`agent hub is running on loopback only.\nOpen: ${s.url}\n(the link contains a one-time token; stop with Ctrl+C)`);
  void (async () => { try { await syncClaude(db); await syncCodex(db); } catch { /* the UI also has a manual sync button */ } })();
  if (a.flags['no-open'] !== true) {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', s.url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [s.url], { detached: true, stdio: 'ignore' }).unref();
  }
  await new Promise(() => {});
}

async function main(argv: string[]): Promise<void> {
  const a = parse(argv);
  const cmd = a._[0];
  if (a.flags['version']) return out(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version);
  if (!cmd || a.flags['help'] || cmd === 'help') return out(HELP);
  switch (cmd) {
    case 'init': return cmdInit(a);
    case 'undo': { const root = projectArg(a, 1); const id = a._[2] ?? listBackups(root).at(-1); if (!id) return fail('no backups found'); const r = undoBackup(root, id); return out(`Restored ${r.restored} files, removed ${r.removed} created ones (backup ${id}).`); }
    case 'mcp': return cmdMcp(a);
    case 'open': {
      const id = a._[1] as AgentId; const root = projectArg(a, 2);
      if (id !== 'claude' && id !== 'codex') return fail('usage: hub open <claude|codex> [path]');
      const exe = detectAgents()[id];
      if (!exe.installed || !exe.path) return fail(`${id} CLI not found or not runnable without a shell (hub doctor)`);
      const c = spawn(exe.path, [], { cwd: root, stdio: 'inherit', env: pushGuardEnv(HUB_HOME) });
      await new Promise<void>((r) => c.on('close', (code) => { process.exitCode = code ?? 0; r(); }));
      return;
    }
    case 'chat': return cmdRun(a, true);
    case 'run': return cmdRun(a, false);
    case 'ui': return cmdUi(a);
    case 'sync': { const db = openDb(); const t = Date.now(); const c = await syncClaude(db); const x = await syncCodex(db); return out(`claude: ${c.changed} files changed, ${c.messages} messages\ncodex:  ${x.changed} files changed, ${x.messages} messages\n${((Date.now() - t) / 1000).toFixed(1)}s`); }
    case 'history': { const db = openDb(); const q = a._.slice(1).join(' '); if (!q) return fail('usage: hub history <query>'); const hits = search(db, q, { ...(flag(a, 'agent') ? { agent: flag(a, 'agent') as string } : {}) }); return hits.forEach((h) => out(`${h.agent.padEnd(6)} ${(h.project ?? '-').padEnd(18)} ${(h.title ?? '').slice(0, 40).padEnd(40)} ${h.snippet.replace(/\s+/g, ' ')}`)); }
    case 'sessions': { const db = openDb(); const p = flag(a, 'project'); const pr = p ? listProjects(db).find((x) => x.slug === p) : undefined; return listSessions(db, { topLevel: true, limit: 30, ...(pr ? { projectId: pr.id } : {}) }).forEach((s) => out(`${(s.endedAt ?? s.startedAt ?? '').slice(0, 16)}  ${s.agent.padEnd(6)} ${(s.project ?? '-').padEnd(16)} ${(s.model ?? '').padEnd(18)} ${s.title ?? ''}`)); }
    case 'estimate': {
      const db = openDb(); const cls = (flag(a, 'class') ?? 'implement') as TaskClass;
      if (!(cls in ROUTING)) return fail(`class must be one of: ${Object.keys(ROUTING).join(', ')}`);
      const c = advise({ cls }); const est = estimate(profileFromHistory(db, c.agent), c.model, calibrate(db, c.agent), Number(flag(a, 'scale') ?? 1));
      out(`${c.agent} ${c.model} effort ${c.effort}\nwhy: ${c.reason} [${c.rule}]`);
      out(`tokens: ${(est.tokens.low.cachedIn / 1e6).toFixed(1)}–${(est.tokens.high.cachedIn / 1e6).toFixed(1)}M cached + ${(est.tokens.low.uncachedIn / 1e3).toFixed(0)}–${(est.tokens.high.uncachedIn / 1e3).toFixed(0)}k new in`);
      out(`API-equivalent: ${est.usd ? `$${est.usd.low}–$${est.usd.high}` : 'unknown (price not verified)'}   share of weekly limit: ${est.percent ? `${est.percent.low}–${est.percent.high}%` : 'unknown'}   confidence: ${est.confidence}`);
      return est.notes.forEach((n) => out('  · ' + n));
    }
    case 'bench': return cmdBench(a);
    case 'review-eval': return cmdReviewEval(a);
    case 'scout': return cmdScout(a);
    case 'install': return cmdInstall(a);
    case 'get': return cmdGet(a);
    case 'profile': return cmdProfile(a);
    case 'tools': return cmdTools(a);
    case 'config': return cmdConfig(a);
    case 'stage': { const root = projectArg(a, 1); if (a._[2] === 'approve') { const s = approveStage(root, Number(a._[3])); return out(`Stage ${s.id} “${s.title}” approved.`); } return stageStatus(root).forEach((s) => out(`${({ approved: '✔', ready: '◐', current: '▶', blocked: '○' } as Record<string, string>)[s.state]} ${s.id} ${s.title.padEnd(24)} ${s.missing.length ? 'needs: ' + s.missing.join(', ') : 'outputs present'}${s.approvedAt ? '  approved ' + s.approvedAt.slice(0, 10) : ''}`)); }
    case 'hooks': return cmdHooks(a);
    case 'diagram': {
      const root = projectArg(a, 2);
      if (a.flags['check'] || a.flags['write']) { const bad = check(REPO_ROOT, a.flags['write'] === true); if (bad.length) { bad.forEach((b) => out(b)); process.exit(1); } return out(a.flags['write'] ? 'diagrams written to docs/generated/' : 'diagrams are up to date'); }
      const kind = a._[1] as Kind;
      if (!KINDS.includes(kind)) return fail(`usage: hub diagram <${KINDS.join('|')}>`);
      return out(render(build(kind, { root, ...(flag(a, 'entity') ? { entity: flag(a, 'entity') as string } : {}), ...(flag(a, 'file') ? { file: flag(a, 'file') as string } : {}) }), (flag(a, 'format') ?? 'ascii') as Format));
    }
    case 'doctor': {
      const ag = detectAgents();
      if (a.flags['modes']) return cmdModes(a, ag); const major = Number(process.versions.node.split('.')[0]);
      out(`node        ${process.version} ${major >= 24 ? '✔' : '✖ need ≥ 24 (node:sqlite, TypeScript stripping)'}`);
      for (const id of ['claude', 'codex'] as const) out(`${id.padEnd(11)} ${ag[id].installed ? `✔ ${ag[id].version ?? ''}  ${ag[id].path}` : '✖ not found'}`);
      out('login       claude CLI login is checked on the first run (message: "Not logged in" → run `claude` and /login)');
      out(`hub home    ${HUB_HOME}  (index: ${existsSync(join(HUB_HOME, 'hub.sqlite')) ? 'present' : 'not built yet — run: hub sync'})`);
      out(`history     ${existsSync(join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.codex')) ? '✔ ~/.codex' : '- no ~/.codex'}  ${readdirSyncSafe(join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.claude', 'projects')) ? '✔ ~/.claude/projects' : '- no ~/.claude/projects'}`);
      return;
    }
    case 'security': { const c = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'security.mjs')], { stdio: 'inherit' }); await new Promise<void>((r) => c.on('close', (code) => { process.exitCode = code ?? 1; r(); })); return; }
    default: return fail(`unknown command "${cmd}". Run: hub help`);
  }
}
const readdirSyncSafe = (d: string): boolean => { try { return readdirSync(d).length >= 0; } catch { return false; } };

main(process.argv.slice(2)).catch((e: Error) => fail(e.message));
