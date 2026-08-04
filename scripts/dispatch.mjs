#!/usr/bin/env node
// Launch a CLI-agent sidecar (claude/codex/copilot) from a declarative manifest,
// and write a structured ledger record instead of leaving dispatch history to
// be reconstructed later from a raw session transcript.
//
// Usage:
//   node dispatch.mjs --manifest ./some-manifest.json
//   node dispatch.mjs --harness codex --cwd /path/to/repo --prompt "..." [--model MODEL] [--resume-of SESSION_ID] [--label NAME] [--background|--foreground] [--ledger-dir /path]
//
// Per RULES-OF/command-invocation's FREEFORM_CONTENT_TRANSITS_FILES_NOT_COMMAND_LINES:
// the prompt is delivered via stdin wherever a harness documents that support
// (claude, codex), never as a shell-parsed command-line argument. Copilot's
// -p flag has no documented file/stdin alternative, so it remains a CLI
// argument there — but is still protected from corruption by the Windows
// invocation fix below.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function resolveBinaryNoFallback(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`'${name}' not found in PATH`);
}

// A .cmd/.bat file is not a real executable — Windows' CreateProcess (used
// directly by spawn/spawnSync without shell:true) cannot run it at all, even
// given the exact resolved path; it fails with EINVAL. shell:true is
// required, but Node's own array-to-command-line concatenation under
// shell:true does not reliably quote a path containing spaces AND does not
// safely preserve arguments containing shell metacharacters (confirmed live:
// a prompt with a nested single-quoted phrase was corrupted this way).
// The robust fix: build the full command-line string ourselves — proper
// Windows cmd.exe argument quoting (wrap in double quotes, double any
// internal double quotes) applied to every token, joined with spaces — and
// pass that single pre-quoted string as spawnSync's command with no separate
// args array, so Node does no further concatenation of its own. Verified
// against a payload containing quotes, &, |, <, >, ^, and % with
// byte-for-byte preservation, and against a target path containing spaces.
function winCmdQuote(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function buildWinCommandLine(bin, args) {
  return [bin, ...args].map(winCmdQuote).join(' ');
}

let npmGlobalBinDirCache;
function npmGlobalBinDir() {
  // npm itself usually ships bundled with the Node install and IS on PATH,
  // even when npm-installed globals (codex, copilot, ...) land in a
  // user-specific directory that isn't. Ask npm, don't guess the path.
  if (npmGlobalBinDirCache !== undefined) return npmGlobalBinDirCache;
  try {
    const npmBin = resolveBinaryNoFallback('npm');
    const { command, args, options } = winSafeInvocation(npmBin, ['config', 'get', 'prefix']);
    const r = spawnSync(command, args, { ...options, encoding: 'utf8' });
    const prefix = (r.stdout || '').trim();
    npmGlobalBinDirCache = prefix ? (process.platform === 'win32' ? prefix : path.join(prefix, 'bin')) : null;
  } catch {
    npmGlobalBinDirCache = null;
  }
  return npmGlobalBinDirCache;
}

function resolveBinary(name) {
  try {
    return resolveBinaryNoFallback(name);
  } catch {
    const npmBinDir = npmGlobalBinDir();
    if (npmBinDir) {
      const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
      for (const ext of exts) {
        const candidate = path.join(npmBinDir, name + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    throw new Error(`could not resolve '${name}' on PATH or npm's global bin dir (${npmBinDir ?? 'unknown'}) — is it installed?`);
  }
}

// Returns { command, args, options } ready for spawn/spawnSync. On Windows,
// for a .cmd/.bat target, this means a single fully-pre-quoted command
// string with shell:true and an empty args array (see buildWinCommandLine
// above) — passing args separately here would let Node re-concatenate them
// itself, undoing the manual quoting. On POSIX, this is just a passthrough.
function winSafeInvocation(bin, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return { command: buildWinCommandLine(bin, args), args: [], options: { shell: true } };
  }
  return { command: bin, args, options: {} };
}

function parseArgs(argv) {
  const args = { background: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifestPath = argv[++i];
    else if (a === '--harness') args.harness = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--prompt') args.prompt = argv[++i];
    else if (a === '--prompt-file') args.prompt = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--resume-of') args.resumeOf = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--background') args.background = true;
    else if (a === '--foreground') args.background = false;
    else if (a === '--ledger-dir') args.ledgerDir = argv[++i];
  }
  return args;
}

function loadManifest(args) {
  let manifest = {};
  if (args.manifestPath) {
    manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  }
  manifest = {
    model: null,
    background: true,
    resumeOf: null,
    label: null,
    disclosure: null,
    ...manifest,
    ...Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && k !== 'manifestPath' && k !== 'ledgerDir')),
  };
  for (const req of ['harness', 'cwd', 'prompt']) {
    if (!manifest[req]) throw new Error(`manifest missing required field: ${req}`);
  }
  if (!['claude', 'codex', 'copilot'].includes(manifest.harness)) {
    throw new Error(`unknown harness: ${manifest.harness}`);
  }
  if (!fs.existsSync(manifest.cwd)) {
    throw new Error(`cwd does not exist: ${manifest.cwd}`);
  }
  const leaf = path.basename(manifest.cwd);
  if (leaf === '_') {
    throw new Error(`cwd's own leaf name is a bare '_' — known git-worktree-metadata collision risk. Launch in a real named folder and create '_' nesting beneath it instead.`);
  }
  return manifest;
}

// Adapter table — verified against each harness's own --help. Recheck before
// editing if a harness version changes; never hand-guess a flag name.
// Returns { cmd: [...], stdinPrompt: boolean } — when stdinPrompt is true,
// the prompt is NOT in cmd and must be piped via stdin instead (see
// RULES-OF/command-invocation).
function buildCommand(m) {
  const resuming = !!m.resumeOf;
  switch (m.harness) {
    case 'claude': {
      const cmd = ['claude'];
      if (resuming) cmd.push('-r', m.resumeOf);
      cmd.push('-p', '--dangerously-skip-permissions', '--output-format', 'json');
      if (m.model) cmd.push('--model', m.model);
      return { cmd, stdinPrompt: true };
    }
    case 'codex': {
      const cmd = ['codex', 'exec'];
      if (resuming) cmd.push('resume', m.resumeOf);
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
      if (m.model) cmd.push('-m', m.model);
      if (!resuming) cmd.push('-C', m.cwd);
      cmd.push('-'); // explicit stdin marker per codex's own documented convention
      return { cmd, stdinPrompt: true };
    }
    case 'copilot': {
      // No documented file/stdin alternative to -p for copilot; the prompt
      // stays a CLI argument, protected from corruption by winSafeInvocation
      // rather than by file-mediation.
      const cmd = ['copilot'];
      if (resuming) cmd.push(`--resume=${m.resumeOf}`);
      else cmd.push('--session-id', m.dispatchId); // pre-assign so the ID is known before launch
      cmd.push('-p', m.prompt, '--allow-all-tools');
      if (m.model) cmd.push('--model', m.model);
      if (!resuming) cmd.push('-C', m.cwd);
      return { cmd, stdinPrompt: false };
    }
    default:
      throw new Error(`no adapter for harness: ${m.harness}`);
  }
}

function extractSessionId(harness, output, fallback) {
  if (harness === 'codex') {
    const match = output.match(/session id:\s*([0-9a-f-]{20,})/i);
    return match ? match[1] : fallback;
  }
  if (harness === 'claude') {
    // --output-format json prints a single JSON object; find the last
    // parseable JSON line rather than assuming it's the whole output.
    const lines = output.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.session_id) return obj.session_id;
      } catch {
        continue;
      }
    }
    return fallback;
  }
  if (harness === 'copilot') return fallback; // pre-assigned via --session-id
  return fallback;
}

function ledgerPaths(ledgerDir) {
  const dir = ledgerDir || path.join(process.cwd(), '.agent-dispatch');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return {
    dir,
    logFile: path.join(dir, 'dispatch-log.jsonl'),
    logsDir: path.join(dir, 'logs'),
  };
}

function appendLedger(logFile, record) {
  fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args);
  const dispatchId = randomUUID();
  manifest.dispatchId = dispatchId;

  const { logFile, logsDir } = ledgerPaths(args.ledgerDir);
  const { cmd, stdinPrompt } = buildCommand(manifest);
  const [binName, ...cmdArgs] = cmd;
  const resolvedBin = resolveBinary(binName);
  const { command, args: finalArgs, options: invocationOptions } = winSafeInvocation(resolvedBin, cmdArgs);
  const startedAt = new Date().toISOString();

  if (manifest.background) {
    const logPath = path.join(logsDir, `${dispatchId}.log`);
    const out = fs.openSync(logPath, 'a');
    const child = spawn(command, finalArgs, {
      cwd: manifest.cwd,
      detached: true,
      stdio: [stdinPrompt ? 'pipe' : 'ignore', out, out],
      ...invocationOptions,
    });
    if (stdinPrompt) {
      child.stdin.end(manifest.prompt, 'utf8');
    }
    child.unref();
    appendLedger(logFile, {
      dispatchId,
      ts: startedAt,
      event: 'dispatch_started',
      harness: manifest.harness,
      cwd: manifest.cwd,
      model: manifest.model,
      resumeOf: manifest.resumeOf,
      label: manifest.label,
      disclosure: manifest.disclosure,
      background: true,
      pid: child.pid,
      logPath,
      sessionId: manifest.harness === 'copilot' && !manifest.resumeOf ? dispatchId : null,
    });
    console.log(JSON.stringify({ dispatchId, pid: child.pid, logPath, status: 'launched-background' }));
    return;
  }

  const result = spawnSync(command, finalArgs, {
    cwd: manifest.cwd,
    encoding: 'utf8',
    input: stdinPrompt ? manifest.prompt : undefined,
    ...invocationOptions,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const fallbackSessionId = manifest.harness === 'copilot' && !manifest.resumeOf ? dispatchId : manifest.resumeOf;
  const sessionId = extractSessionId(manifest.harness, output, fallbackSessionId);

  appendLedger(logFile, {
    dispatchId,
    ts: startedAt,
    event: 'dispatch_completed',
    harness: manifest.harness,
    cwd: manifest.cwd,
    model: manifest.model,
    resumeOf: manifest.resumeOf,
    label: manifest.label,
    disclosure: manifest.disclosure,
    background: false,
    exitCode: result.status,
    sessionId,
  });

  process.stdout.write(result.stdout || '');
  if (result.status !== 0) process.stderr.write(result.stderr || '');
  process.exitCode = result.status ?? 1;
}

main();
