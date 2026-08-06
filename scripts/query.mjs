#!/usr/bin/env node
// Read the dispatch ledger and answer history questions in one query instead
// of grepping a raw multi-hundred-MB session transcript.
//
// Usage:
//   node query.mjs [--ledger-dir /path] [--harness codex] [--resumed] [--fresh] [--label NAME] [--json]

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ledger-dir') args.ledgerDir = argv[++i];
    else if (a === '--harness') args.harness = argv[++i];
    else if (a === '--resumed') args.resumed = true;
    else if (a === '--fresh') args.fresh = true;
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.ledgerDir || path.join(process.cwd(), '.agent-dispatch');
  const logFile = path.join(dir, 'dispatch-log.jsonl');

  if (!fs.existsSync(logFile)) {
    console.log(`No dispatch ledger found at ${logFile}. Nothing has been dispatched from here yet.`);
    return;
  }

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  let records = lines.map((l) => JSON.parse(l));

  if (args.harness) records = records.filter((r) => r.harness === args.harness);
  if (args.resumed) records = records.filter((r) => r.resumeOf != null);
  if (args.fresh) records = records.filter((r) => r.resumeOf == null);
  if (args.label) records = records.filter((r) => r.label === args.label);

  if (args.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log('No matching dispatch records.');
    return;
  }

  for (const r of records) {
    const kind = r.resumeOf ? `RESUME of ${r.resumeOf}` : 'FRESH';
    const model = r.model ? ` model=${r.model}` : '';
    const label = r.label ? ` "${r.label}"` : '';
    const boundary = r.sessionBoundary
      ? ` boundary=${r.sessionBoundary.sidecarIntent ?? 'unknown'}/${r.sessionBoundary.durableIdentity ?? 'unknown'}/${r.sessionBoundary.disposition ?? 'unknown'}`
      : '';
    console.log(`${r.ts}  ${r.harness.padEnd(7)}  ${kind}${model}${label}  sessionId=${r.sessionId ?? '(pending)'}  event=${r.event}${boundary}`);
  }
  console.log(`\n${records.length} record(s) matched.`);
}

main();
