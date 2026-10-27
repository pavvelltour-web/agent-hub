# Agent Hub: start check for Windows. READ-ONLY: it looks at what is installed and prints the next command.
# It downloads nothing, installs nothing, writes no file, changes no setting (no execution policy, no PATH, no registry).
# Run from the repository folder:  powershell -NoProfile -File scripts\install.ps1
# ASCII only on purpose: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$problems = 0

function Say([string]$text) { Write-Host $text }
function Probe([string]$name) { $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { return $c.Source } return $null }

Say 'Agent Hub: checking this PC (nothing is installed or changed)'
Say ''

# Node.js 24 or newer (built-in node:sqlite and TypeScript type stripping)
$node = Probe 'node'
if (-not $node) {
  Say '[missing] Node.js. Install Node.js 24 or newer from https://nodejs.org (LTS or Current), open a new terminal, and run this check again.'
  $problems++
} else {
  $raw = (& $node --version).Trim()
  $ver = $null
  try { $ver = [version]($raw.TrimStart('v')) } catch { $ver = $null }
  if (-not $ver) { Say "[?] Node.js answered '$raw', which is not a version number."; $problems++ }
  elseif ($ver.Major -lt 24) { Say "[too old] Node.js $raw. Agent Hub needs 24 or newer: install it from https://nodejs.org, open a new terminal, and run this check again."; $problems++ }
  else { Say "[ok] Node.js $raw" }
}

# Git (worktrees for tasks, checkpoints for handoff)
$git = Probe 'git'
if ($git) { Say '[ok] Git' } else { Say '[missing] Git. Install Git for Windows from https://git-scm.com and run this check again.'; $problems++ }

# The agents are optional: the hub works with one of them or none (demo mode)
foreach ($agent in @('claude', 'codex')) {
  if (Probe $agent) { Say "[ok] $agent CLI found (the hub checks sign-in itself; it never opens credential files)" }
  else { Say "[optional] $agent CLI not found. The hub works without it; install it later if you want to run that agent." }
}

Say ''
if ($problems -gt 0) {
  Say "$problems problem(s) above. Fix them and run this check again. Nothing was changed."
  exit 1
}

Say 'Ready. Next, in this folder:'
Say "  cd `"$root`""
Say '  npm install              (installs TypeScript for development only; the hub has zero runtime dependencies)'
Say '  node bin/hub.js doctor   (what the hub can see on this PC)'
Say '  node bin/hub.js ui       (opens the panel on 127.0.0.1; prints a one-time link)'
Say '  node bin/hub.js ui --demo   (same, with scripted fake agents: spends no limits)'
exit 0
