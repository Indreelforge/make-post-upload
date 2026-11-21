// Loads the app source tree into one plain object. Reads files only; no network.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Section files of each component kind, in upload order.
export const MODULE_SECTIONS = ['api', 'parameters', 'expect', 'interface', 'samples'];
export const RPC_SECTIONS = ['api', 'parameters'];
export const CONNECTION_SECTIONS = ['api', 'parameters'];
export const WEBHOOK_SECTIONS = ['api', 'parameters', 'attach', 'detach'];

// Make's module type ids (POST /sdk/apps/{app}/{version}/modules, `typeId` enum).
export const TYPE = { TRIGGER: 1, ACTION: 4, SEARCH: 9, INSTANT_TRIGGER: 10, RESPONDER: 11, UNIVERSAL: 12 };

/** Removes // and block comments outside strings, so commented IMLJSON (JSONC) parses. */
export function stripComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true; out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      out += text[i] ?? '';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated block comment');
      out += ' ';
      i = end + 1;
    } else out += ch;
  }
  return out;
}

export function parseJsonc(text, file = 'input') {
  try {
    return JSON.parse(stripComments(text));
  } catch (error) {
    throw new SyntaxError(`${file}: ${error.message}`);
  }
}

function readJson(root, rel) {
  return parseJsonc(readFileSync(join(root, rel), 'utf8'), rel);
}

function readSections(root, dir, names) {
  const sections = {};
  for (const name of names) {
    const rel = join(dir, `${name}.imljson`);
    if (!existsSync(join(root, rel))) continue;
    const text = readFileSync(join(root, rel), 'utf8');
    sections[name] = { file: rel, text, data: parseJsonc(text, rel) };
  }
  return sections;
}

function components(root, dir, names) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => statSync(join(base, name)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      meta: readJson(root, join(dir, name, 'metadata.json')),
      sections: readSections(root, join(dir, name), names),
    }));
}

/** Every .imljson file under the app source folders (relative paths). */
export function listImljson(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.') || name === 'test') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.imljson')) found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

export function loadProject(root = ROOT) {
  const readText = (rel) => ({ file: rel, text: readFileSync(join(root, rel), 'utf8') });
  const base = readText('base.imljson');
  const groups = readText('groups.imljson');
  return {
    root,
    app: readJson(root, 'app.json'),
    base: { ...base, data: parseJsonc(base.text, base.file) },
    groups: { ...groups, data: parseJsonc(groups.text, groups.file) },
    docs: readText('docs/readme.md'),
    icon: { file: 'icon.png', bytes: readFileSync(join(root, 'icon.png')) },
    connection: { meta: readJson(root, 'connection/metadata.json'), sections: readSections(root, 'connection', CONNECTION_SECTIONS) },
    webhook: { meta: readJson(root, 'webhook/metadata.json'), sections: readSections(root, 'webhook', WEBHOOK_SECTIONS) },
    rpcs: components(root, 'rpcs', RPC_SECTIONS),
    modules: components(root, 'modules', MODULE_SECTIONS),
  };
}
