// Static structure of the app source: parsing, interfaces/samples, naming, references,
// search limits, the universal module, sanitization, connection and webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listImljson, loadProject, parseJsonc, ROOT, TYPE } from '../scripts/lib/project.mjs';
import * as checks from '../scripts/lib/checks.mjs';

const project = loadProject();
const none = (problems) => assert.deepEqual(problems, [], problems.join('\n'));

test('every .imljson file parses as JSON(C)', () => {
  const files = listImljson();
  assert.ok(files.length > 200, `only ${files.length} section files found`);
  for (const file of files) assert.doesNotThrow(() => parseJsonc(readFileSync(join(ROOT, file), 'utf8'), file), file);
});

test('the JSONC parser accepts comments and keeps // inside strings', () => {
  assert.deepEqual(parseJsonc('{\n // c\n "u": "https://x.y/z", /* b */ "n": 1 }'), { u: 'https://x.y/z', n: 1 });
});

test('app metadata and icon follow Make requirements', () => none(checks.checkApp(project)));

test('the app has the expected component counts', () => {
  assert.ok(project.modules.length >= 40, `${project.modules.length} modules`);
  assert.equal(project.rpcs.length, 9);
  const byType = (t) => project.modules.filter((m) => m.meta.typeId === t).length;
  assert.equal(byType(TYPE.INSTANT_TRIGGER), 1);
  assert.ok(byType(TYPE.SEARCH) >= 10);
});

test('every module has api, interface and samples (and expect unless it is an instant trigger)', () => none(checks.checkModuleSections(project)));

test('sample keys match interface names', () => none(checks.checkSamples(project)));

test('sampleProblems catches a missing, an unknown and a mistyped sample field', () => {
  const spec = [{ name: 'id', type: 'text' }, { name: 'n', type: 'uinteger' }, { name: 'c', type: 'collection', spec: [{ name: 'x', type: 'boolean' }] }];
  const problems = checks.sampleProblems('m', spec, { id: '1', n: 'two', extra: 1, c: { x: 'no' } });
  assert.equal(problems.length, 3, problems.join('\n'));
});

test('module and RPC names match /^[a-zA-Z][0-9a-zA-Z]+[0-9a-zA-Z]$/', () => none(checks.checkNames(project)));

test('labels follow Make naming conventions', () => none(checks.checkLabels(project)));

test('the label checker rejects title case and wrong verbs', () => {
  assert.ok(checks.sentenceCaseProblems('Upload A Video').length > 0);
  assert.deepEqual(checks.sentenceCaseProblems('List LinkedIn pages'), []);
  assert.deepEqual(checks.sentenceCaseProblems('Get the X post allowance'), []);
  const bad = { ...project, modules: [{ name: 'x1y', meta: { label: 'Fetch uploads', description: 'Returns a list of uploads.', typeId: TYPE.SEARCH }, sections: {} }] };
  assert.ok(checks.checkLabels(bad).some((p) => /should start with one of/.test(p)));
});

test('every rpc:// reference exists and every RPC is used', () => none(checks.checkRpcReferences(project)));

test('the reference checker reports a missing RPC', () => {
  const broken = structuredClone(project);
  broken.modules[0].sections.expect.data[0].options = 'rpc://doesNotExist';
  assert.ok(checks.checkRpcReferences(broken).some((p) => p.includes('rpc://doesNotExist')));
});

test('every module is in exactly one group', () => none(checks.checkGroups(project)));

test('exactly one universal module, on the hard-coded host', () => {
  none(checks.checkUniversal(project));
  const universal = project.modules.find((m) => m.meta.typeId === TYPE.UNIVERSAL);
  assert.equal(universal.name, 'makeApiCall');
  assert.equal(universal.meta.label, 'Make an API call');
});

test('search modules have a limit and pagination where the API pages', () => {
  none(checks.checkSearchLimits(project));
  for (const name of ['searchUploads', 'listWebhookDeliveries']) {
    const api = project.modules.find((m) => m.name === name).sections.api.data;
    assert.ok(api.pagination?.qs?.page === '{{pagination.page}}', `${name} paginates by page`);
    assert.ok(api.pagination.condition, `${name} stops paginating`);
  }
});

test('sanitize is set in base, connection and webhook attach', () => none(checks.checkSanitize(project)));

test('connection and webhook follow the Post-Upload API contract', () => none(checks.checkConnectionAndWebhook(project)));

test('modules that send dates format them with formatDate', () => {
  for (const name of ['uploadVideo', 'uploadVideoFile', 'uploadPhotos', 'uploadPhotoFile', 'createTextPost', 'updateScheduledPost']) {
    const text = project.modules.find((m) => m.name === name).sections.api.text;
    assert.match(text, /formatDate\(parameters\.(schedule|scheduled_date), 'YYYY-MM-DDTHH:mm:ssZ'\)/, name);
  }
  for (const m of project.modules) {
    for (const f of m.sections.expect?.data ?? []) {
      if (f.type === 'date') assert.match(m.sections.api.text, new RegExp(`formatDate\\(parameters\\.${f.name}`), `${m.name}.${f.name} is formatted`);
    }
  }
});

test('selectors in get, update and delete modules can be mapped (mode: edit)', () => {
  for (const m of project.modules.filter((x) => /^(get|update|delete|cancel|retry|disconnect)/.test(x.name))) {
    for (const f of (m.sections.expect?.data ?? []).filter((p) => p.type === 'select' && typeof p.options === 'string' && p.required)) {
      if (['getNextQueueSlot', 'getQueueSettings', 'updateQueueSettings'].includes(m.name)) continue;
      assert.equal(f.mode, 'edit', `${m.name}.${f.name}`);
      assert.match(f.label, /\bID\b|name$/, `${m.name}.${f.name}: a mapped identifier label names the identifier`);
    }
  }
});

test('no secrets or private hosts in the source', () => {
  for (const file of [...listImljson(), 'app.json', 'docs/readme.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /api-dev\.post-upload\.com|localhost|127\.0\.0\.1/, file);
    assert.doesNotMatch(text, /(sk|pk)_(live|test)_[A-Za-z0-9]{8,}|Apikey [A-Za-z0-9]{16,}/, file);
  }
});
