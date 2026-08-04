---
name: agent-dispatch
description: Launch, resume, and track externally-launched CLI coding-agent sidecars (Claude Code, Codex, Copilot CLI) with consistent permissions, working directory, and telemetry
scope: Any agent that needs to dispatch a genuinely separate CLI-agent process (not a same-thread subagent) and later answer "what did I launch, and did I ever resume it"
trigger: Before shelling out to `claude`, `codex`, or `copilot` as a sidecar process, or before asking "has this session been resumed / what have I dispatched so far"
---

# Agent Dispatch

## Goal

Dispatching a real, externally-launched CLI-agent process (as opposed to a same-thread subagent) is easy to do inconsistently: different harnesses need different permission flags, different resume syntax, and — without a structured record — answering "did I ever give this session a second task" degenerates into grepping a multi-hundred-MB session transcript by hand.

This skill is the discipline of doing that consistently: one declarative manifest per launch, one adapter table (verified against each harness's own `--help`, never assumed), and one small structured ledger that answers dispatch-history questions in one query instead of an archaeology session.

## Core discipline

1. **Never invoke a harness's permission/sandbox/resume flags from memory.** Verify against that harness's own `--help` before hardcoding an adapter — CLI flags drift across versions, and a decoy flag that looks right (e.g. `--allow-dangerously-skip-permissions` vs `--dangerously-skip-permissions`) is a real, observed failure mode.
2. **A dispatch is either fresh or a resume — the manifest says which, explicitly.** `resumeOf` defaults to `null`. Never leave this implicit in a prompt string or a folder name; a later query needs to answer "was this resumed" without re-deriving it from context.
3. **Model tier is independently settable on resume.** Escalating from a lower-tier model to a higher one mid-thread (to break a stuck reasoning/refusal loop) is a real, intentional operational pattern, not an edge case — a resumed dispatch's `model` field may legitimately differ from the original dispatch's.
4. **Write the ledger record when the dispatch starts, not reconstructed afterward.** The point of the ledger is to make "what have I launched" a solved problem; if it's only ever populated retroactively, it degrades back into the same archaeology it's meant to replace.
5. **The launch CWD is always a real, named folder** — typically a git working-copy root. Any further axis-based nesting (role × harness × branch, etc.) is created by the dispatch script itself *beneath* that CWD, never as the CWD's own name. A bare `_` as a terminal/leaf folder name is a known collision risk in git's own worktree metadata naming.
6. **Don't confer a persistent identity (a 🍍/pineapple card, in this ecosystem's own terms) casually.** Dispatch produces a resumable session ID; that's a mechanical fact. Deciding a given dispatch deserves an ongoing, accountable identity — one that matters to the dispatching agent *and* signals something to the dispatched agent about its own durability — is a separate, deliberate decision this skill does not make automatically.
7. **Treat prompt text as an experimental variable.** A dispatched agent's answer is shaped by what it has been shown. Track which facts, examples, labels, and candidate conclusions have been revealed, and do not contaminate an identity, continuity, or capability probe by naming the categories you hope to test.

## Prompt hygiene for agent-facing dispatch

Before sending a prompt to another agent, separate parent-side control from child-facing context.

- Keep stop conditions, evaluation criteria, and "what this proves" in the parent ledger unless the dispatched agent needs them to execute the task.
- Ask for direct observations before asking for interpretation. Prefer "what can you see, recall, or verify?" over "are you a fork, sidecar, or station?"
- Do not prime identity labels, role names, card ids, model claims, promotion status, or expected conclusions unless those are already known to the dispatched agent or required for the work.
- Do not use negated labels as a substitute for neutrality. "Do not claim X" still introduces X.
- Do not ask a dispatched agent to justify its usefulness or continued existence. Ask what remains unresolved, what evidence it can preserve, or what next information would clarify the task.
- When a task concerns another agent's history or identity, use a two-pass prompt: first gather unstructured memory/evidence, then ask classification questions only after the agent has given its own account.
- Record disclosure state in the ledger: what the agent was shown, what it was not shown, and which conclusions were parent-side only.

## Manifest shape

```json
{
  "harness": "claude | codex | copilot",
  "cwd": "absolute path to the launch working directory",
  "prompt": "the task text",
  "model": "optional, harness-specific model id/alias",
  "background": true,
  "resumeOf": null,
  "label": "optional human-readable name for this dispatch"
}
```

## Adapter table (verified, not assumed — recheck against `--help` if a harness version changes)

| Harness | Fresh dispatch | Resume | Verified against |
|---|---|---|---|
| `claude` | `claude -p "<prompt>" --dangerously-skip-permissions --output-format json [-C <cwd>] [--model <model>]` | `claude -r <resumeOf> -p "<prompt>" --dangerously-skip-permissions --output-format json [--model <model>]` | `claude --help` |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox [-C <cwd>] [-m <model>] "<prompt>"` | `codex exec resume <resumeOf> --dangerously-bypass-approvals-and-sandbox [-m <model>] "<prompt>"` | `codex exec --help` |
| `copilot` | `copilot -p "<prompt>" --allow-all-tools [-C <cwd>] [--model <model>]` | `copilot --resume=<resumeOf> -p "<prompt>" --allow-all-tools [--model <model>]` | `copilot --help` |

**Copilot-specific note:** `copilot` also exposes `--session-id <id>` (pre-assign a UUID at launch, or resume/attach by ID) and `--connect[=sessionId]` plus `--remote`/`--remote-export` ("remote control of your session from GitHub web and mobile"). Whether a session started in VSCode's own Copilot Chat shares that same remote-session ID space with the CLI — i.e. whether `copilot --resume=<vscode-session-id>` actually attaches to it — is a real, testable hypothesis, not yet confirmed either way.

**Known harness-specific hazards, worth checking before trusting a fresh environment:**
- Codex's `workspace-write` sandbox mode (the default) runs commands under a genuinely separate OS security principal on at least one observed Windows host, blocking credential-manager and git-ownership access. `--dangerously-bypass-approvals-and-sandbox` resolves this — confirmed live by running `whoami`/`gh auth status`/`git fetch` before and after.
- `code chat` (VSCode's own CLI entry point, distinct from the standalone `copilot` CLI) has no resume flag as of the last check — one-shot only. Resuming a VSCode-originated session, if possible at all, means either the `copilot --resume`/`--connect` cross-surface path above, or UI automation (e.g. `pywinauto`) targeting the running VSCode window directly — a substantially harder, unverified path.
- **On Windows, npm-installed harnesses (`codex`, `copilot`) are `.cmd` shims, not real executables.** `spawn`/`spawnSync` without `shell:true` fails outright (`EINVAL`) even given the exact resolved path — Windows' `CreateProcess` cannot run a `.cmd` file directly. `shell:true` is required, but Node's own array-to-command-line concatenation under it does **not** reliably quote a path containing spaces, and does **not** safely preserve prompt text containing shell metacharacters — confirmed live: a prompt with a nested single-quoted phrase (`Run 'echo ...' and report it`) was silently corrupted this way, a plain functional break on ordinary text, not an adversarial-input edge case. The fix implemented here: build the full command-line string manually with proper Windows `cmd.exe` argument quoting (wrap every token in double quotes, double any internal double quotes) and pass that single pre-quoted string as the command with an empty args array and `shell:true` — never let Node do its own concatenation on top. See `scripts/dispatch.mjs`'s `winCmdQuote`/`buildWinCommandLine`. Per `RULES-OF/command-invocation`'s `FREEFORM_CONTENT_TRANSITS_FILES_NOT_COMMAND_LINES`, the prompt itself is additionally kept off the command line entirely wherever the harness supports it — see next point.
- **Prompt delivery avoids the command line altogether where possible.** `claude` and `codex` both document stdin-based prompt input (codex explicitly: "if not provided as an argument, instructions are read from stdin"); this toolkit pipes the prompt via stdin for both, never as a CLI argument, eliminating the shell-quoting risk above for the highest-risk field regardless of platform. `copilot`'s `-p <text>` has no documented file/stdin alternative — its prompt remains a CLI argument, protected only by the manual quoting above, not by file-mediation. This is a known, narrower exception, not an oversight.
- This entire class of bug does not exist on POSIX (Linux/macOS) — `winSafeInvocation` is a no-op there, and `spawn(bin, args)` with a real argv array is already safe. The Windows-specific code path is isolated behind a single `process.platform === 'win32'` check specifically so it cannot regress POSIX behavior; it has not yet been tested on an actual POSIX host, though, and should be before being trusted there.

## Ledger

One JSONL line per dispatch, written at launch time:

```json
{"ts": "2026-08-04T18:00:00Z", "harness": "codex", "cwd": "...", "model": null, "resumeOf": null, "sessionId": "019f...", "label": "...", "status": "launched"}
```

A regenerated summary/projection (not just the raw log) should back the actual query tool — the same event-log-plus-projection shape as any other durable operational record, not a flat file meant to be re-parsed from scratch every time.

## Explicitly out of scope for this skill

- Deciding *when* a dispatch deserves a persistent identity/card — that's a judgment call belonging to whoever's doing the dispatching, informed by this skill's mechanics but not automated by them.
- UI-automation-based resume of a VSCode-only chat session — a real, harder problem, not solved here.
- Any project-specific paths, hostnames, or account names — those belong in the *consuming* project's own ops repo, never here.
