// In-memory stand-in for `make.sdk` (@makehq/sdk 1.8.1 method names and argument order).
// Used by `--dry-run` and the tests: it makes no network request. It stores sections as the
// uploaded text and returns them on read, so it proves the upload sequence, not that Make
// accepts the sections.
export function createMockClient({ assignNames = true } = {}) {
  const apps = new Map(); // `${name}@${version}` -> app
  const calls = [];
  const note = (method, ...args) => calls.push({ method, args: args.map((a) => (typeof a === 'string' && a.length > 80 ? `<${a.length} chars>` : a)) });
  const notFound = () => Object.assign(new Error('Not found'), { statusCode: 404 });
  const app = (name, version) => {
    const found = apps.get(`${name}@${version}`);
    if (!found) throw notFound();
    return found;
  };
  const connections = new Map();
  const webhooks = new Map();
  let seq = 0;
  const generated = (prefix) => (assignNames ? `${prefix}${++seq === 1 ? '' : seq}` : prefix);

  const client = {
    calls,
    apps: {
      async list() { note('apps.list'); return [...apps.values()].map(({ name, version, label, public: pub }) => ({ name, version, label, public: pub })); },
      async get(name, version) { note('apps.get', name, version); const a = app(name, version); return { name: a.name, version: a.version, public: a.public }; },
      async create(body) {
        note('apps.create', body.name);
        if (!body.audience) throw Object.assign(new Error('audience required'), { statusCode: 400 });
        const a = { name: body.name, version: 1, label: body.label, public: body.private === false, sections: {}, docs: '', icon: null, modules: new Map(), rpcs: new Map() };
        apps.set(`${a.name}@1`, a);
        return { name: a.name, version: 1, label: a.label, public: a.public };
      },
      async update(name, version, body) { note('apps.update', name, version); Object.assign(app(name, version), { label: body.label }); return {}; },
      async setSection(name, version, section, body) { note('apps.setSection', name, version, section, body); app(name, version).sections[section] = body; },
      async getSection(name, version, section) { note('apps.getSection', name, version, section); return app(name, version).sections[section] ?? null; },
      async setDocs(name, version, docs) { note('apps.setDocs', name, version); app(name, version).docs = docs; return true; },
      async getDocs(name, version) { note('apps.getDocs', name, version); return app(name, version).docs; },
      async setIcon(name, version, bytes) {
        note('apps.setIcon', name, version);
        const b = Buffer.from(bytes);
        if (b.readUInt32BE(16) !== 512 || b.readUInt32BE(20) !== 512) throw new Error('App icon must be 512x512 PNG');
        app(name, version).icon = b.length;
        return true;
      },
    },
    connections: {
      async list(appName) { note('connections.list', appName); return [...connections.values()].filter((c) => c.app === appName).map(({ name, label, type }) => ({ name, label, type })); },
      async create(appName, body) { note('connections.create', appName); const c = { name: generated(appName), app: appName, label: body.label, type: body.type, sections: {} }; connections.set(c.name, c); return { name: c.name, label: c.label, type: c.type }; },
      async update(name, body) { note('connections.update', name); const c = connections.get(name); if (!c) throw notFound(); c.label = body.label ?? c.label; return { name, label: c.label, type: c.type }; },
      async setSection(name, section, body) { note('connections.setSection', name, section, body); const c = connections.get(name); if (!c) throw notFound(); c.sections[section] = body; },
      async getSection(name, section) { note('connections.getSection', name, section); return connections.get(name)?.sections[section] ?? null; },
    },
    webhooks: {
      async list(appName) { note('webhooks.list', appName); return [...webhooks.values()].filter((w) => w.app === appName).map(({ name, label, type, connection }) => ({ name, label, type, connection })); },
      async create(appName, body) { note('webhooks.create', appName); const w = { name: generated(appName), app: appName, label: body.label, type: body.type, connection: body.connection, sections: {} }; webhooks.set(w.name, w); return { label: w.label, type: w.type }; },
      async update(name, body) { note('webhooks.update', name); const w = webhooks.get(name); if (!w) throw notFound(); Object.assign(w, body); return { name, label: w.label, type: w.type }; },
      async setSection(name, section, body) { note('webhooks.setSection', name, section, body); const w = webhooks.get(name); if (!w) throw notFound(); w.sections[section] = body; },
      async getSection(name, section) { note('webhooks.getSection', name, section); return webhooks.get(name)?.sections[section] ?? null; },
    },
    rpcs: {
      async list(appName, version) { note('rpcs.list', appName, version); return [...app(appName, version).rpcs.values()].map(({ name, label }) => ({ name, label })); },
      async create(appName, version, body) { note('rpcs.create', appName, version, body.name); app(appName, version).rpcs.set(body.name, { ...body, sections: {} }); return { name: body.name, label: body.label }; },
      async update(appName, version, name, body) { note('rpcs.update', appName, version, name); const r = app(appName, version).rpcs.get(name); if (!r) throw notFound(); Object.assign(r, body); return r; },
      async setSection(appName, version, name, section, body) { note('rpcs.setSection', appName, version, name, section, body); const r = app(appName, version).rpcs.get(name); if (!r) throw notFound(); r.sections[section] = body; },
      async getSection(appName, version, name, section) { note('rpcs.getSection', appName, version, name, section); return app(appName, version).rpcs.get(name)?.sections[section] ?? null; },
    },
    modules: {
      async list(appName, version) { note('modules.list', appName, version); return [...app(appName, version).modules.values()].map(({ name, label, typeId }) => ({ name, label, typeId })); },
      async get(appName, version, name) { note('modules.get', appName, version, name); const m = app(appName, version).modules.get(name); if (!m) throw notFound(); return { name: m.name, label: m.label, typeId: m.typeId, connection: m.connection ?? null, webhook: m.webhook ?? null }; },
      async create(appName, version, body) { note('modules.create', appName, version, body.name); app(appName, version).modules.set(body.name, { ...body, sections: {} }); return { name: body.name, typeId: body.typeId, label: body.label }; },
      async update(appName, version, name, body) { note('modules.update', appName, version, name); const m = app(appName, version).modules.get(name); if (!m) throw notFound(); Object.assign(m, body); return m; },
      async setSection(appName, version, name, section, body) { note('modules.setSection', appName, version, name, section, body); const m = app(appName, version).modules.get(name); if (!m) throw notFound(); m.sections[section] = body; },
      async getSection(appName, version, name, section) { note('modules.getSection', appName, version, name, section); return app(appName, version).modules.get(name)?.sections[section] ?? null; },
    },
  };
  return client;
}
