# Topology guard: development override, NOT verified enforcement

Owner: 🔱A♦️.🦈A♥️.📎A♥️ q0.0.3.
Source: SKILL-OF/agent-dispatch, branch codex/three-red-aces/topology-guard, commit 50cf5ec.
Installed copy: C:/Users/victorb/.codex/hooks/topology-guard.mjs.
Configuration: C:/Users/victorb/.codex/hooks.json and hooks/topology-guard-policy.json.
Scope: Codex only, KPFM manager office cwd and descendants. Claude unchanged.
Prior state: no topology guard; existing hooks preserved. Prior config snapshot hooks/hooks.before-topology-guard.json.
Reason: six standalone sibling sessions created despite an explicit nested-subagent request.
Policy: deny Codex app create_thread and fork_thread in this office. Deliberate peer creation is also denied until explicit policy revision. Native nested creation, existing-agent contact and reads remain allowed.

Validation: six source tests pass; installed script returns deny for a synthetic real-office create_thread event. Live read-only list_projects canary returned normally: enforcement FAILED acceptance in the current runtime. Probe disabled afterward. Reload requirement/cause remains unverified. Do not claim the runtime blocks peer creation yet.

Retirement: independent review and merged source, supported installer, and verified runtime denial before tool execution. Preserve worktree until source is integrated. Rollback removes only the topology-guard matcher from hooks.json, preserving concurrent hook changes; policy/script may remain inert. Do not overwrite current hooks.json with the historical backup.

Next owner: three-red-aces. Next bounded action: verify refreshed runtime loads configured hook using a read-only canary, then disable canary and prove ordinary reads still work. No agent creation as a test. Full semantic authorization and CLI sidecar paths are outside this containment guard. Never infer coverage for another harness.