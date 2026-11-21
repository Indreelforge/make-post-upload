#!/usr/bin/env node
// Refreshes test/fixtures/openapi.json, the API contract the tests check against.
//   node scripts/sync-openapi.mjs                 downloads https://api.post-upload.com/openapi.json
//   node scripts/sync-openapi.mjs <path-to-file>  copies a local file (e.g. ../indreelforge/backend/public/openapi.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/project.mjs';

const source = process.argv[2];
const text = source ? readFileSync(source, 'utf8') : await (await fetch('https://api.post-upload.com/openapi.json')).text();
const doc = JSON.parse(text);
if (!doc.openapi || !doc.paths) throw new Error('not an OpenAPI document');
writeFileSync(join(ROOT, 'test/fixtures/openapi.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(`Saved ${Object.keys(doc.paths).length} paths from ${source ?? 'api.post-upload.com'}.`);
