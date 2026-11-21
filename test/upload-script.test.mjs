// The uploader against the in-memory mock client: full sequence, idempotency, readback
// detection and the CLI's credential handling. No network request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../scripts/lib/project.mjs';
import { createMockClient } from '../scripts/lib/mock-client.mjs';
import { sameSection, uploadApp } from '../scripts/lib/upload-core.mjs';
import { readEnvFile, run, ZONE_PATTERN } from '../scripts/upload.mjs';

const project = loadProject();

test('a first upload creates every component, writes and reads back every section', async () => {
  const client = createMockClient();
  const report = await uploadApp(client, project);
  assert.ok(report.ok, JSON.stringify(report.steps.filter((s) => s.status === 'failed')));
  assert.equal(report.counts.created, 1 + 1 + 1 + project.rpcs.length + project.modules.length);
  const sections = 2 + 2 + 4 + project.rpcs.reduce((n, r) => n + Object.keys(r.sections).length, 0) + project.modules.reduce((n, m) => n + Object.keys(m.sections).length, 0);
  assert.equal(report.counts.sections, sections);
  const createdApp = client.calls.find((c) => c.method === 'apps.create');
  assert.ok(createdApp);
  const trigger = client.calls.filter((c) => c.method === 'modules.create').length;
  assert.equal(trigger, project.modules.length);
});

test('a second upload creates nothing and updates in place', async () => {
  const client = createMockClient();
  const first = await uploadApp(client, project);
  const second = await uploadApp(client, project, { state: { appName: first.app.name, appVersion: first.app.version, connection: first.connection, webhook: first.webhook } });
  assert.ok(second.ok);
  assert.equal(second.counts.created, 0);
  // Without saved state, components are found by label.
  const third = await uploadApp(client, project);
  assert.ok(third.ok);
  assert.equal(third.counts.created, 0);
});

test('the app is created private and the instant trigger is bound to the webhook', async () => {
  const client = createMockClient();
  const report = await uploadApp(client, project);
  const full = await client.apps.get(report.app.name, report.app.version);
  assert.equal(full.public, false);
  const trigger = await client.modules.get(report.app.name, report.app.version, 'watchUploadEvents');
  assert.equal(trigger.webhook, report.webhook);
  assert.equal(trigger.connection, report.connection);
  for (const m of project.modules) assert.equal((await client.modules.get(report.app.name, report.app.version, m.name)).connection, report.connection);
});

test('a readback that differs fails the upload and stops', async () => {
  const client = createMockClient();
  const original = client.modules.getSection;
  client.modules.getSection = async (...args) => (args[2] === 'uploadVideo' && args[3] === 'api' ? '{"url":"/other"}' : original(...args));
  const report = await uploadApp(client, project);
  assert.equal(report.ok, false);
  const failed = report.steps.find((s) => s.status === 'failed');
  assert.equal(failed.name, 'module.uploadVideo.api.readback');
  assert.match(failed.detail, /readback differs at \$\.url/);
});

test('remote errors are reported by status only, never by body', async () => {
  const client = createMockClient();
  client.apps.list = async () => { throw Object.assign(new Error('secret section text'), { statusCode: 403 }); };
  const report = await uploadApp(client, project);
  assert.equal(report.ok, false);
  assert.match(report.steps[0].detail, /HTTP 403: permission denied/);
  assert.doesNotMatch(JSON.stringify(report), /secret section text/);
});

test('a module whose type changed is not overwritten', async () => {
  const client = createMockClient();
  const first = await uploadApp(client, project);
  await client.modules.update(first.app.name, first.app.version, 'getUpload', { typeId: 9 });
  const second = await uploadApp(client, project);
  assert.equal(second.ok, false);
  assert.match(second.steps.find((s) => s.status === 'failed').detail, /cannot change a module type/);
});

test('readback comparison accepts JSON text or parsed JSON and ignores formatting', () => {
  assert.equal(sameSection({ a: [1, 2] }, '{ "a": [1,2] }'), null);
  assert.equal(sameSection({ a: [1, 2] }, { a: [1, 2] }), null);
  assert.equal(sameSection({ a: 1 }, '// note\n{"a": 1}'), null);
  assert.match(sameSection({ a: 1 }, { a: 2 }), /\$\.a/);
  assert.match(sameSection({ a: 1 }, null), /empty/);
});

test('the dry run validates and uploads to the mock twice', async () => {
  const lines = [];
  const code = await run(['--dry-run'], { out: (l) => lines.push(l), err: (l) => lines.push(l), connect: () => assert.fail('the dry run must not connect') });
  assert.equal(code, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /0 components created \(expected 0\)/);
});

test('the live mode refuses to start without credentials and never prints the key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mpu-'));
  const lines = [];
  // An empty project root: checks fail before any credential is read.
  assert.equal(await run(['--live'], { root, envFile: null, env: {}, out: (l) => lines.push(l), err: (l) => lines.push(l), connect: () => assert.fail('must not connect') }), 1);
  lines.length = 0;
  const env = { MAKE_API_KEY: '', MAKE_ZONE: '' };
  const code = await run(['--live'], { env, envFile: null, out: (l) => lines.push(l), err: (l) => lines.push(l), connect: () => assert.fail('must not connect') });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /MAKE_API_KEY is not set/);
  lines.length = 0;
  const code2 = await run(['--live'], { envFile: null, env: { MAKE_API_KEY: 'k-very-secret-value', MAKE_ZONE: 'https://eu1.make.com/api/v2' }, out: (l) => lines.push(l), err: (l) => lines.push(l), connect: () => assert.fail('must not connect') });
  assert.equal(code2, 2);
  assert.match(lines.join('\n'), /bare Make hostname/);
  assert.doesNotMatch(lines.join('\n'), /k-very-secret-value/);
});

test('the live mode checks the token scopes before writing', async () => {
  const lines = [];
  const connect = async () => ({ make: { users: { currentAuthorization: async () => ({ scope: ['sdk-apps:read'] }) } }, client: createMockClient() });
  const code = await run(['--live'], { envFile: null, env: { MAKE_API_KEY: 'k', MAKE_ZONE: 'eu1.make.com' }, root: project.root, out: (l) => lines.push(l), err: (l) => lines.push(l), connect });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /lacks the scope\(s\): sdk-apps:write/);
});

test('zones and .env.local parsing', () => {
  for (const z of ['eu1.make.com', 'us2.make.com', 'eu1.make.celonis.com']) assert.match(z, ZONE_PATTERN);
  for (const z of ['https://eu1.make.com', 'eu1.make.com/api/v2', 'evil.com', 'eu1.make.com.evil.com']) assert.doesNotMatch(z, ZONE_PATTERN);
  const dir = mkdtempSync(join(tmpdir(), 'mpu-env-'));
  const file = join(dir, '.env.local');
  writeFileSync(file, '# comment\nMAKE_API_KEY="abc"\nexport MAKE_ZONE=eu1.make.com\nBROKEN LINE\n');
  assert.deepEqual(readEnvFile(file, { MAKE_ZONE: 'us1.make.com' }), { MAKE_API_KEY: 'abc', MAKE_ZONE: 'us1.make.com' });
  assert.deepEqual(readEnvFile(join(dir, 'missing'), { A: '1' }), { A: '1' });
});
