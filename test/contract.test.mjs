// API contract: every request the app sends uses a path + method that exists in the Post-Upload
// OpenAPI document, and request fields match the OpenAPI schema or the Zapier app (the reference
// integration whose requests were verified against the live API).
//
// OpenAPI source: $POST_UPLOAD_OPENAPI (for example ../indreelforge/backend/public/openapi.json)
// or the snapshot in test/fixtures/openapi.json (refresh with `npm run sync:openapi`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, ROOT, TYPE } from '../scripts/lib/project.mjs';

const project = loadProject();
const openapiPath = process.env.POST_UPLOAD_OPENAPI || join(ROOT, 'test/fixtures/openapi.json');
const openapi = JSON.parse(readFileSync(openapiPath, 'utf8'));
const zapier = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/zapier-reference.json'), 'utf8')).operations;
const BASE = project.base.data.baseUrl;

// Fields the API accepts (see the route code) that the OpenAPI document does not describe yet.
// Each entry is an OpenAPI gap to fix in backend/public/openapi.json, not an app problem.
const UNDOCUMENTED = {
};

/** Every outgoing request definition: [owner, request]. */
function requests() {
  const out = [];
  const add = (owner, api) => { for (const r of Array.isArray(api) ? api : [api]) if (r && r.url) out.push([owner, r]); };
  for (const m of project.modules) if (m.meta.typeId !== TYPE.UNIVERSAL) add(`modules/${m.name}`, m.sections.api.data);
  for (const r of project.rpcs) add(`rpcs/${r.name}`, r.sections.api.data);
  add('webhook/attach', project.webhook.sections.attach.data);
  add('webhook/detach', project.webhook.sections.detach.data);
  add('connection/api', project.connection.sections.api.data);
  return out;
}

const template = (path) => path.replace(/\{\{[^}]+\}\}|\{[^}]+\}/g, '{}');
function operation(method, url) {
  const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
  assert.ok(path.startsWith('/api/'), `relative API path expected, got ${url}`);
  const key = template(path.split('?')[0]);
  const entry = Object.entries(openapi.paths).find(([p]) => template(p) === key);
  return { key, path: entry?.[0], op: entry?.[1]?.[method.toLowerCase()] };
}
function bodyProperties(op) {
  const props = new Set();
  for (const content of Object.values(op?.requestBody?.content ?? {})) {
    const ref = content.schema?.$ref;
    const schema = ref ? openapi.components.schemas[ref.split('/').pop()] : content.schema;
    for (const k of Object.keys(schema?.properties ?? {})) props.add(k);
  }
  return props;
}
const ownerName = (owner) => owner.replace(/^modules\//, '');
const keysOf = (obj) => Object.keys(obj ?? {}).filter((k) => k !== '{{...}}');

const all = requests();

test('the app sends requests to at least 40 API operations', () => {
  const ops = new Set(all.map(([, r]) => `${r.method ?? 'GET'} ${template(r.url)}`));
  assert.ok(ops.size >= 40, `${ops.size} distinct operations`);
});

for (const [owner, req] of all) {
  const method = req.method ?? 'GET';
  test(`${owner}: ${method} ${req.url} exists in the OpenAPI document`, () => {
    const { op, key } = operation(method, req.url);
    assert.ok(op, `${method} ${key} is not in ${openapiPath}`);
  });

  test(`${owner}: request fields are documented or match the Zapier app`, () => {
    const { op, key } = operation(method, req.url);
    const gaps = UNDOCUMENTED[`${method} ${key}`] ?? {};
    const ref = zapier[ownerName(owner)] ?? {};
    const allowedBody = new Set([...bodyProperties(op), ...(ref.body ?? []), ...(gaps.body ?? [])]);
    const unknownBody = keysOf(req.body).filter((k) => !allowedBody.has(k));
    assert.deepEqual(unknownBody, [], `body fields not in OpenAPI ${key} nor the Zapier app`);
    const allowedQs = new Set([...(op?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name), ...(ref.qs ?? []), ...(gaps.qs ?? [])]);
    const unknownQs = keysOf(req.qs).filter((k) => !allowedQs.has(k));
    assert.deepEqual(unknownQs, [], `query fields not in OpenAPI ${key} nor the Zapier app`);
    if (req.body && method === 'GET') assert.fail('GET requests must not carry a body');
  });
}

test('the UNDOCUMENTED allowlist has no stale entries', () => {
  for (const [key, gaps] of Object.entries(UNDOCUMENTED)) {
    const [method, path] = key.split(' ');
    const used = all.filter(([, r]) => (r.method ?? 'GET') === method && operation(method, r.url).key === path);
    assert.ok(used.length, `${key} is not used`);
    const { op } = operation(method, used[0][1].url);
    const documentedBody = bodyProperties(op);
    const documentedQs = new Set((op?.parameters ?? []).map((p) => p.name));
    for (const k of gaps.body ?? []) assert.ok(!documentedBody.has(k), `${key} body.${k} is documented now: remove it from UNDOCUMENTED`);
    for (const k of gaps.qs ?? []) assert.ok(!documentedQs.has(k), `${key} qs.${k} is documented now: remove it from UNDOCUMENTED`);
  }
});

// Parity with the Zapier app for the operations both offer.
for (const [name, ref] of Object.entries(zapier)) {
  test(`${name} matches the Zapier app's ${ref.zapier} request`, () => {
    const [kind, comp] = name.includes('/') ? name.split('/') : ['modules', name];
    const req = kind === 'webhook' ? project.webhook.sections[comp].data : project.modules.find((m) => m.name === comp)?.sections.api.data;
    assert.ok(req, `${name} is missing`);
    assert.equal(req.method ?? 'GET', ref.method);
    assert.equal(template(req.url), template(ref.path));
    const body = new Set(keysOf(req.body));
    for (const field of ref.body ?? []) assert.ok(body.has(field), `${name} must send body field "${field}" like Zapier`);
    for (const field of ref.qs ?? []) assert.ok(keysOf(req.qs).includes(field), `${name} must send query field "${field}" like Zapier`);
    if (ref.body?.length === 0) assert.equal(keysOf(req.body).length, 0, `${name} sends no body fields, like Zapier`);
  });
}

test('every Zapier action, search and trigger has a Make counterpart', () => {
  const zapierKeys = new Set(Object.values(zapier).map((r) => r.zapier.split(' ')[0]));
  for (const key of ['upload_video', 'upload_photos', 'post_text', 'edit_scheduled_post', 'cancel_scheduled_post', 'retry_upload', 'create_profile', 'get_connect_link', 'find_upload', 'find_profile', 'upload_*']) {
    assert.ok(zapierKeys.has(key), `${key} has no Make counterpart in the reference map`);
  }
});
