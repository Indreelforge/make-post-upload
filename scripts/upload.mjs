#!/usr/bin/env node
// Uploads the Post-Upload app to Make with @makehq/sdk 1.8.1, or validates it offline.
//
//   node scripts/upload.mjs --dry-run   static checks + full upload sequence against an in-memory
//                                       mock (run twice to prove idempotency). No network, no SDK.
//   node scripts/upload.mjs --live      creates or updates the app in your Make account. Reads
//                                       MAKE_API_KEY and MAKE_ZONE from the environment or .env.local.
//
// Management tooling only: this script is not Make app runtime code. It never prints the API key,
// section source or API error bodies, and it never publishes the app or requests a review.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProject, ROOT } from './lib/project.mjs';
import { runAllChecks } from './lib/checks.mjs';
import { uploadApp } from './lib/upload-core.mjs';
import { createMockClient } from './lib/mock-client.mjs';

// The key is sent to this host only: accept bare Make hostnames (eu1.make.com, us2.make.com, eu1.make.celonis.com …).
export const ZONE_PATTERN = /^[a-z0-9-]+\.make\.(?:com|celonis\.com)$/;
const STATE_FILE = '.make-state.json';

const USAGE = `Usage: node scripts/upload.mjs (--dry-run | --live)

  --dry-run  Validate the app and run the upload sequence against an in-memory mock. No network.
  --live     Create or update the app in Make. Needs MAKE_API_KEY and MAKE_ZONE (for example
             eu1.make.com) in the environment or in .env.local. The token needs the
             sdk-apps:read and sdk-apps:write scopes. Optional: MAKE_APP_AUDIENCE (default from
             app.json, used only when the app is created).`;

/** Reads KEY=VALUE lines from .env.local without printing them; existing env vars win. */
export function readEnvFile(path, env = {}) {
  if (!existsSync(path)) return { ...env };
  const out = { ...env };
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (out[m[1]] === undefined || out[m[1]] === '') out[m[1]] = value;
  }
  return out;
}

export function formatReport(report, mode) {
  const failed = report.steps.filter((s) => s.status === 'failed');
  const warned = report.steps.filter((s) => s.status === 'warn');
  const lines = [
    mode === 'mock' ? 'Mode: dry run. An in-memory stand-in was used; no Make API call was made.' : 'Mode: live. Requests were sent to the Make API.',
    `App: ${report.app.name} v${report.app.version}; connection ${report.connection ?? '-'}; webhook ${report.webhook ?? '-'}`,
    `Components created ${report.counts.created}, updated ${report.counts.updated}; sections written and read back ${report.counts.sections}.`,
    ...warned.map((s) => `Warning: ${s.name}: ${s.detail}`),
    ...failed.map((s) => `FAILED: ${s.name}: ${s.detail}`),
    report.ok ? 'Result: OK.' : 'Result: FAILED. Later steps did not run; completed writes are not rolled back. Re-run after fixing: the upload is idempotent.',
    mode === 'mock'
      ? 'Evidence: checks the upload sequence and local sources only, not that Make accepts the sections.'
      : 'Evidence: every section was read back and compared. No scenario was run and the app was not published.',
  ];
  return lines.join('\n');
}

export async function connectToMake({ apiKey, zone }) {
  const { Make } = await import('@makehq/sdk');
  // Retry only on 429 (writes are full-section PUTs or creates Make rejected); never on 5xx,
  // where the outcome of a create is uncertain.
  const make = new Make(apiKey, zone, { retry: { maxRetries: 6, onRateLimit: true, onServerError: false } });
  return { make, client: make.sdk };
}

export async function run(argv, { env = process.env, root = ROOT, envFile = join(root, '.env.local'), out = console.log, err = console.error, connect = connectToMake } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { 'dry-run': { type: 'boolean' }, live: { type: 'boolean' }, help: { type: 'boolean' } } }));
  } catch {
    err(USAGE);
    return 2;
  }
  if (values.help) { out(USAGE); return 0; }
  if (Boolean(values['dry-run']) === Boolean(values.live)) { err(USAGE); return 2; }

  let project;
  try {
    project = loadProject(root);
  } catch (error) {
    err(`Could not load the app source: ${error.message}`);
    return 1;
  }
  const problems = runAllChecks(project);
  if (problems.length) {
    for (const p of problems) err(`check failed: ${p}`);
    err(`${problems.length} static check(s) failed; nothing was uploaded.`);
    return 1;
  }
  out(`Static checks passed: ${project.modules.length} modules, ${project.rpcs.length} RPCs, 1 connection, 1 webhook.`);

  if (values['dry-run']) {
    const client = createMockClient();
    const first = await uploadApp(client, project, {});
    out(formatReport(first, 'mock'));
    const state = { appName: first.app.name, appVersion: first.app.version, connection: first.connection, webhook: first.webhook };
    const second = await uploadApp(client, project, { state });
    const idempotent = second.ok && second.counts.created === 0;
    out(`Second dry run: ${second.ok ? 'OK' : 'FAILED'}, ${second.counts.created} components created (expected 0).`);
    return first.ok && idempotent ? 0 : 1;
  }

  const vars = envFile ? readEnvFile(envFile, env) : { ...env };
  const apiKey = vars.MAKE_API_KEY;
  const zone = vars.MAKE_ZONE;
  const missing = [];
  if (!apiKey) missing.push('MAKE_API_KEY is not set (environment or .env.local).');
  if (!zone) missing.push('MAKE_ZONE is not set, for example eu1.make.com.');
  else if (!ZONE_PATTERN.test(zone)) missing.push('MAKE_ZONE must be a bare Make hostname such as eu1.make.com (no https://, path or /api/v2).');
  if (missing.length) { for (const m of missing) err(m); err(USAGE); return 2; }

  const statePath = join(root, STATE_FILE);
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const state = saved.zone === zone ? saved : {};
  const saveState = (patch) => {
    Object.assign(state, patch, { zone });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  };

  let session;
  try {
    session = await connect({ apiKey, zone });
    const auth = await session.make.users.currentAuthorization();
    const scopes = auth?.scope ?? [];
    const lacking = ['sdk-apps:read', 'sdk-apps:write'].filter((s) => !scopes.includes(s));
    if (lacking.length) { err(`The Make token lacks the scope(s): ${lacking.join(', ')}. Create a token with sdk-apps:read and sdk-apps:write.`); return 1; }
  } catch (error) {
    const status = typeof error?.statusCode === 'number' ? ` (HTTP ${error.statusCode})` : '';
    err(`Could not authenticate with Make${status}. Check MAKE_API_KEY and that MAKE_ZONE is the zone the token was created in.`);
    return 1;
  }

  const report = await uploadApp(session.client, project, { state, audience: vars.MAKE_APP_AUDIENCE || undefined, saveState, log: out });
  out(formatReport(report, 'live'));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2));
}
