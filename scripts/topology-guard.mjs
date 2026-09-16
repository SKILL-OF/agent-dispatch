import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function decide(event, policy) {
  if (event.hook_event_name !== 'PreToolUse') return null;
  const normalize = p => path.win32.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const cwd = normalize(event.cwd || '.');
  const scoped = policy.officeRoots.some(root => {
    const base = normalize(root);
    return cwd === base || cwd.startsWith(base + '\\');
  });
  if (!scoped) return null;
  if (policy.deniedTools.includes(event.tool_name)) return 'Peer creation is disabled in this office. A sibling or sidecar is not a subagent. Use the native nested subagent mechanism for a subagent request; unavailable durability never permits substitution.';
  if (policy.readOnlyProbe && event.tool_name === policy.probeTool) return 'TOPOLOGY_GUARD_CANARY: read-only probe denied before execution.';
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    const policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const reason = decide(event, policy);
    if (reason) {
      console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}));
    }
  } catch (error) {
    process.stderr.write('Topology guard configuration/input failure: ' + error.message);
    process.exitCode = 2;
  }
}
