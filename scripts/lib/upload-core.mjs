// Creates or updates the Make app from the local source through a `make.sdk`-shaped client
// (@makehq/sdk 1.8.1, or the in-memory mock for --dry-run). Idempotent: existing components are
// updated in place, missing ones are created, and every section written is read back and compared.
// Management tooling only: this is not Make app runtime code.
import { isDeepStrictEqual } from 'node:util';
import { CONNECTION_SECTIONS, MODULE_SECTIONS, RPC_SECTIONS, TYPE, WEBHOOK_SECTIONS, parseJsonc } from './project.mjs';

export class StepFailure extends Error {}

/** Describes a remote error by status only: messages and bodies can echo section source or credentials. */
export function describeRemoteError(error) {
  if (error instanceof StepFailure) return error.message;
  const status = typeof error?.statusCode === 'number' ? error.statusCode : undefined;
  if (status === undefined) {
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'error';
    return `request failed without a usable response (${name}); the outcome is uncertain, check the app in Make before re-running`;
  }
  const meaning = status === 400 || status === 422 ? 'request rejected as invalid'
    : status === 401 ? 'authentication rejected: check MAKE_API_KEY and MAKE_ZONE'
    : status === 403 ? 'permission denied: the token needs the sdk-apps:read and sdk-apps:write scopes'
    : status === 404 ? 'not found'
    : status === 409 ? 'conflict (for example the app name is taken)'
    : status === 429 ? 'rate limited after retries'
    : status >= 500 ? 'Make service error; the outcome is uncertain, check the app in Make before re-running'
    : 'unexpected response';
  return `HTTP ${status}: ${meaning}`;
}

/** First differing JSON path between two values (for readback reports without printing content). */
export function firstDifference(a, b, path = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
      if (d) return d;
    }
  }
  return path;
}

/** Make may return a section as JSON text or as parsed JSON; compare semantically either way. */
export function sameSection(expected, readback) {
  let actual = readback;
  if (typeof readback === 'string') {
    try { actual = parseJsonc(readback, 'readback'); } catch { return 'readback is not JSON'; }
  }
  if (actual === null || actual === undefined) return 'readback is empty';
  const diff = firstDifference(expected, actual);
  return diff ? `readback differs at ${diff}` : null;
}

export async function uploadApp(client, project, { state = {}, audience, saveState = () => {}, log = () => {} } = {}) {
  const steps = [];
  const counts = { created: 0, updated: 0, sections: 0 };
  const record = (name, status, detail) => { steps.push({ name, status, detail }); log(`${status === 'ok' ? 'ok  ' : status === 'warn' ? 'warn' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      record(name, 'ok', typeof detail === 'string' ? detail : undefined);
    } catch (error) {
      record(name, 'failed', describeRemoteError(error));
      throw new StepFailure(name);
    }
  };
  const warn = (name, detail) => record(name, 'warn', detail);

  const { app } = project;
  let appName = state.appName ?? app.name;
  let version = state.appVersion ?? app.version;
  let connName = state.connection;
  let hookName = state.webhook;

  const writeSection = async (label, write, read, section) => {
    await step(`${label}.write`, () => write(section.text));
    await step(`${label}.readback`, async () => {
      const problem = sameSection(section.data, await read());
      if (problem) throw new StepFailure(problem);
    });
    counts.sections += 1;
  };

  try {
    // 1. App: find it, or create it as a private app.
    await step('app', async () => {
      const apps = await client.apps.list({ cols: ['name', 'version', 'label', 'public'] });
      const existing = (apps ?? []).find((a) => a.name === appName && Number(a.version) === Number(version));
      if (existing) {
        await client.apps.update(appName, version, { label: app.label, description: app.description, theme: app.theme, language: app.language });
        counts.updated += 1;
        return `updated ${appName} v${version}${existing.public ? ' (public)' : ' (private)'}`;
      }
      const created = await client.apps.create({
        name: appName, label: app.label, description: app.description, theme: app.theme,
        language: app.language, audience: audience ?? app.audience, private: true,
      });
      counts.created += 1;
      if (created.public === true) throw new StepFailure('Make reported the new app as public; nothing else was written');
      appName = created.name;
      version = created.version;
      saveState({ appName, appVersion: version });
      const full = await client.apps.get(appName, version, { cols: ['name', 'version', 'public'] });
      if (full.public !== false) throw new StepFailure('could not confirm that the new app is private; nothing else was written');
      return `created private app ${appName} v${version}${appName !== app.name ? ` (Make assigned this name; app.json asks for ${app.name})` : ''}`;
    });

    // 2. Base, documentation and icon.
    await writeSection('base', (t) => client.apps.setSection(appName, version, 'base', t), () => client.apps.getSection(appName, version, 'base'), project.base);
    await step('docs.write', () => client.apps.setDocs(appName, version, project.docs.text));
    await step('docs.readback', async () => {
      const docs = await client.apps.getDocs(appName, version);
      if (typeof docs !== 'string' || docs.trim() !== project.docs.text.trim()) throw new StepFailure('readback differs from docs/readme.md');
    });
    await step('icon.write', () => client.apps.setIcon(appName, version, new Uint8Array(project.icon.bytes)));

    // 3. Connection (app-wide; Make assigns its name).
    await step('connection', async () => {
      const list = await client.connections.list(appName) ?? [];
      let found = list.find((c) => c.name === connName) ?? list.find((c) => c.label === project.connection.meta.label && c.type === project.connection.meta.type);
      if (found) {
        await client.connections.update(found.name, { label: project.connection.meta.label });
        counts.updated += 1;
      } else {
        found = await client.connections.create(appName, { type: project.connection.meta.type, label: project.connection.meta.label });
        counts.created += 1;
      }
      connName = found.name;
      saveState({ connection: connName });
      return connName;
    });
    for (const s of CONNECTION_SECTIONS) {
      const section = project.connection.sections[s];
      if (section) await writeSection(`connection.${s}`, (t) => client.connections.setSection(connName, s, t), () => client.connections.getSection(connName, s), section);
    }

    // 4. RPCs (modules and the webhook reference them).
    const remoteRpcs = new Set((await client.rpcs.list(appName, version) ?? []).map((r) => r.name));
    for (const rpc of project.rpcs) {
      await step(`rpc.${rpc.name}`, async () => {
        if (remoteRpcs.has(rpc.name)) {
          await client.rpcs.update(appName, version, rpc.name, { label: rpc.meta.label, connection: connName });
          counts.updated += 1;
          return 'updated';
        }
        await client.rpcs.create(appName, version, { name: rpc.name, label: rpc.meta.label, connection: connName });
        counts.created += 1;
        return 'created';
      });
      for (const s of RPC_SECTIONS) {
        const section = rpc.sections[s];
        if (section) await writeSection(`rpc.${rpc.name}.${s}`, (t) => client.rpcs.setSection(appName, version, rpc.name, s, t), () => client.rpcs.getSection(appName, version, rpc.name, s), section);
      }
    }

    // 5. Webhook (app-wide; Make assigns its name and the create response omits it).
    await step('webhook', async () => {
      const { label, type } = project.webhook.meta;
      const before = await client.webhooks.list(appName) ?? [];
      let found = before.find((w) => w.name === hookName) ?? before.find((w) => w.label === label && w.type === type);
      if (found) {
        await client.webhooks.update(found.name, { label, connection: connName });
        counts.updated += 1;
      } else {
        await client.webhooks.create(appName, { type, label, connection: connName });
        counts.created += 1;
        const seen = new Set(before.map((w) => w.name));
        found = (await client.webhooks.list(appName) ?? []).find((w) => !seen.has(w.name) && w.label === label);
        if (!found) throw new StepFailure('the webhook was created but could not be found by its label; check the app in Make before re-running');
      }
      hookName = found.name;
      saveState({ webhook: hookName });
      return hookName;
    });
    for (const s of WEBHOOK_SECTIONS) {
      const section = project.webhook.sections[s];
      if (section) await writeSection(`webhook.${s}`, (t) => client.webhooks.setSection(hookName, s, t), () => client.webhooks.getSection(hookName, s), section);
    }

    // 6. Modules.
    const remoteModules = new Map((await client.modules.list(appName, version) ?? []).map((m) => [m.name, m]));
    for (const m of project.modules) {
      const { label, description, typeId } = m.meta;
      await step(`module.${m.name}`, async () => {
        const existing = remoteModules.get(m.name);
        if (existing) {
          if (existing.typeId !== undefined && Number(existing.typeId) !== typeId) throw new StepFailure(`exists with type ${existing.typeId}, expected ${typeId}; Make cannot change a module type, delete or rename it in Make first`);
          await client.modules.update(appName, version, m.name, { label, description, connection: connName });
          counts.updated += 1;
          return 'updated';
        }
        const body = { name: m.name, typeId, label, description, moduleInitMode: 'blank', connection: connName };
        if (m.meta.webhook) body.webhook = hookName;
        await client.modules.create(appName, version, body);
        counts.created += 1;
        return 'created';
      });
      for (const s of MODULE_SECTIONS) {
        const section = m.sections[s];
        if (section) await writeSection(`module.${m.name}.${s}`, (t) => client.modules.setSection(appName, version, m.name, s, t), () => client.modules.getSection(appName, version, m.name, s), section);
      }
      await step(`module.${m.name}.verify`, async () => {
        const full = await client.modules.get(appName, version, m.name);
        if (Number(full.typeId) !== typeId) throw new StepFailure(`type is ${full.typeId}, expected ${typeId}`);
        if (full.connection !== undefined && full.connection !== connName) throw new StepFailure(`bound to connection ${full.connection}, expected ${connName}`);
        if (m.meta.webhook && full.webhook !== undefined && full.webhook !== hookName) throw new StepFailure(`bound to webhook ${full.webhook}, expected ${hookName}; the SDK cannot rebind a webhook, set it in the Make editor`);
      });
    }

    // 7. Groups last: they reference the modules.
    await writeSection('groups', (t) => client.apps.setSection(appName, version, 'groups', t), () => client.apps.getSection(appName, version, 'groups'), project.groups);

    // 8. Inventory: report remote components this source does not define (never deleted).
    const local = new Set(project.modules.map((m) => m.name));
    const extra = (await client.modules.list(appName, version) ?? []).map((m) => m.name).filter((n) => !local.has(n));
    if (extra.length) warn('inventory', `modules in Make but not in this source (left untouched): ${extra.join(', ')}`);
    else record('inventory', 'ok', `${local.size} modules, ${project.rpcs.length} RPCs, 1 connection, 1 webhook`);
  } catch (error) {
    if (!(error instanceof StepFailure)) record('unexpected', 'failed', describeRemoteError(error));
  }

  const ok = steps.every((s) => s.status !== 'failed');
  return { ok, app: { name: appName, version }, connection: connName, webhook: hookName, steps, counts };
}
