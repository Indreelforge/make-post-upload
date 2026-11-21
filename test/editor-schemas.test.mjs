// Validates every component file against the JSON schemas Make's web editor uses (draft-07),
// vendored in test/editor-schemas from integromat/vscode-apps-sdk (see LICENSE.md there).
// The editor shows violations as warnings; here they fail the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { listImljson, parseJsonc, ROOT } from '../scripts/lib/project.mjs';

const SCHEMAS = join(ROOT, 'test/editor-schemas');
// strict:false and unicodeRegExp:false are required for these schemas to load (see the skill notes).
const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, name), 'utf8')), name);

const BY_SECTION = { api: 'api.json', attach: 'api.json', detach: 'api.json', parameters: 'parameters.json', expect: 'parameters.json', interface: 'parameters.json', samples: 'samples.json' };
function schemaFor(rel) {
  if (rel === 'base.imljson') return 'base.json';
  if (rel === 'groups.imljson') return 'groups.json';
  const section = rel.split('/').pop().replace('.imljson', '');
  // The receiving `api` of a webhook is not a request; the editor has no schema for it.
  if (rel === 'webhook/api.imljson') return null;
  return BY_SECTION[section] ?? null;
}

const files = listImljson();

test('every section file except the webhook receiver has an editor schema', () => {
  const without = files.filter((f) => !schemaFor(f));
  assert.deepEqual(without, ['webhook/api.imljson']);
});

for (const file of files) {
  const schema = schemaFor(file);
  if (!schema) continue;
  test(`${file} is valid for the Make editor (${schema})`, () => {
    const validate = ajv.getSchema(schema);
    const data = parseJsonc(readFileSync(join(ROOT, file), 'utf8'), file);
    const ok = validate(data);
    assert.ok(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2));
  });
}

test('the validator catches a typo the editor would flag', () => {
  const validate = ajv.getSchema('api.json');
  assert.equal(validate({ url: '/api/me', method: 'GET', followRedirect: false }), false);
  assert.equal(ajv.getSchema('parameters.json')([{ name: 'when', type: 'datetime', label: 'When' }]), false);
});
