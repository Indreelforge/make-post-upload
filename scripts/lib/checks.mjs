// Static checks of the app source. Each check returns a list of problems (empty = pass).
// Used by `npm test` and by `scripts/upload.mjs` before anything is uploaded.
import { TYPE } from './project.mjs';

// Make: module, RPC and IML function names, 3–48 characters.
export const NAME_PATTERN = /^[a-zA-Z][0-9a-zA-Z]+[0-9a-zA-Z]$/;
const JS_RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(' '));

// Make's module naming conventions: first word is the verb (sentence case).
const LABEL_VERBS = {
  [TYPE.INSTANT_TRIGGER]: ['Watch'],
  [TYPE.TRIGGER]: ['Watch'],
  [TYPE.SEARCH]: ['List', 'Search'],
  [TYPE.ACTION]: ['Add', 'Cancel', 'Create', 'Delete', 'Disconnect', 'Download', 'Get', 'Remove', 'Retry', 'Send', 'Update', 'Upload'],
  [TYPE.UNIVERSAL]: ['Make'],
};
// Words that keep their capitals inside a sentence-case label (proper nouns, products, acronyms).
const PROPER = new Set(['Post-Upload', 'API', 'ID', 'IDs', 'URL', 'URLs', 'TikTok', 'YouTube', 'LinkedIn', 'Facebook', 'Pinterest', 'Google', 'Business', 'Instagram', 'X', 'Reddit', 'Bluesky', 'Telegram', 'Slack', 'Discord', 'Mastodon', 'Threads', 'WordPress', 'MB', 'HTTPS']);

const PROPER_PHRASES = ['Google Business Profile', 'X (formerly Twitter)'];

export function sentenceCaseProblems(label) {
  const words = PROPER_PHRASES.reduce((text, phrase) => text.replace(phrase, 'Brand'), label).split(/\s+/);
  if (!/^[A-Z]/.test(words[0])) return [`"${label}" must start with a capital letter`];
  return words.slice(1)
    .map((w) => w.replace(/[(),.:%]/g, ''))
    .filter((w) => /[A-Z]/.test(w) && !PROPER.has(w))
    .map((w) => `"${label}": "${w}" is capitalized; labels are sentence case`);
}

export function checkNames(project) {
  const problems = [];
  for (const [kind, list] of [['module', project.modules], ['RPC', project.rpcs]]) {
    for (const { name } of list) {
      if (name.length < 3 || name.length > 48) problems.push(`${kind} ${name}: name must be 3–48 characters`);
      if (!NAME_PATTERN.test(name)) problems.push(`${kind} ${name}: name must match ${NAME_PATTERN}`);
      if (JS_RESERVED.has(name)) problems.push(`${kind} ${name}: name is a JavaScript reserved word`);
    }
  }
  return problems;
}

export function checkLabels(project) {
  const problems = [];
  const seen = new Map();
  for (const m of project.modules) {
    const { label, description, typeId } = m.meta;
    if (!label) { problems.push(`${m.name}: missing label`); continue; }
    if (seen.has(label)) problems.push(`${m.name}: label "${label}" also used by ${seen.get(label)}`);
    seen.set(label, m.name);
    problems.push(...sentenceCaseProblems(label).map((p) => `${m.name}: ${p}`));
    const verbs = LABEL_VERBS[typeId] ?? [];
    const verb = label.split(' ')[0];
    if (!verbs.includes(verb)) problems.push(`${m.name}: label "${label}" should start with one of ${verbs.join(', ')} for type ${typeId}`);
    if (typeId === TYPE.UNIVERSAL && label !== 'Make an API call') problems.push(`${m.name}: the universal module must be labelled "Make an API call"`);
    if (!description || !/\.$/.test(description)) problems.push(`${m.name}: description must be a sentence ending with a period`);
    if (typeId === TYPE.INSTANT_TRIGGER && !/^Triggers when /.test(description)) problems.push(`${m.name}: trigger descriptions start with "Triggers when"`);
    if (typeId === TYPE.SEARCH && !/^Returns a list of /.test(description)) problems.push(`${m.name}: search descriptions start with "Returns a list of"`);
  }
  // Parameter and output labels are sentence case too.
  const walk = (owner, fields) => {
    for (const f of Array.isArray(fields) ? fields : []) {
      if (f.label) problems.push(...sentenceCaseProblems(f.label).map((p) => `${owner}: ${p}`));
      if (Array.isArray(f.spec)) walk(owner, f.spec);
      else if (f.spec && Array.isArray(f.spec.spec)) walk(owner, f.spec.spec);
    }
  };
  for (const m of project.modules) for (const s of ['parameters', 'expect', 'interface']) walk(`${m.name}/${s}`, m.sections[s]?.data);
  walk('webhook/parameters', project.webhook.sections.parameters?.data);
  walk('connection/parameters', project.connection.sections.parameters?.data);
  return problems;
}

export function checkModuleSections(project) {
  const problems = [];
  for (const m of project.modules) {
    const s = m.sections;
    if (!Object.values(TYPE).includes(m.meta.typeId)) problems.push(`${m.name}: unknown typeId ${m.meta.typeId}`);
    for (const required of ['api', 'interface', 'samples']) if (!s[required]) problems.push(`${m.name}: missing ${required}.imljson`);
    if (m.meta.typeId === TYPE.INSTANT_TRIGGER) {
      if (s.expect) problems.push(`${m.name}: instant triggers have static parameters only (no expect.imljson)`);
      if (!m.meta.webhook) problems.push(`${m.name}: instant trigger must be bound to the webhook (metadata.webhook = true)`);
    } else {
      if (!s.expect) problems.push(`${m.name}: missing expect.imljson`);
      if (m.meta.webhook) problems.push(`${m.name}: only instant triggers are bound to the webhook`);
    }
    if (s.interface && !Array.isArray(s.interface.data)) problems.push(`${m.name}: interface must be an array`);
    if (s.samples && (typeof s.samples.data !== 'object' || Array.isArray(s.samples.data) || s.samples.data === null)) problems.push(`${m.name}: samples must be one object`);
  }
  return problems;
}

/** Compares a sample object with an interface spec, recursively through collections. */
export function sampleProblems(owner, spec, sample) {
  const problems = [];
  const names = spec.map((f) => f.name);
  const keys = Object.keys(sample);
  for (const k of keys) if (!names.includes(k)) problems.push(`${owner}: sample key "${k}" is not in the interface`);
  for (const f of spec) {
    if (!(f.name in sample)) { if (owner.split('.').length === 1) problems.push(`${owner}: interface field "${f.name}" has no sample value`); continue; }
    const v = sample[f.name];
    if (v === null) continue;
    if (f.type === 'collection' && Array.isArray(f.spec)) {
      if (typeof v !== 'object' || Array.isArray(v)) problems.push(`${owner}.${f.name}: sample must be an object`);
      else if (f.spec.length) problems.push(...sampleProblems(`${owner}.${f.name}`, f.spec, v));
    } else if (f.type === 'array') {
      if (!Array.isArray(v)) problems.push(`${owner}.${f.name}: sample must be an array`);
      else if (f.spec?.type === 'collection' && Array.isArray(f.spec.spec)) v.forEach((item, i) => problems.push(...sampleProblems(`${owner}.${f.name}[${i}]`, f.spec.spec, item)));
    } else if (['uinteger', 'integer', 'number'].includes(f.type) && typeof v !== 'number') problems.push(`${owner}.${f.name}: sample must be a number`);
    else if (f.type === 'boolean' && typeof v !== 'boolean') problems.push(`${owner}.${f.name}: sample must be a boolean`);
    else if (['text', 'url', 'email', 'date'].includes(f.type) && typeof v !== 'string') problems.push(`${owner}.${f.name}: sample must be a string`);
    if (f.type === 'date' && typeof v === 'string' && Number.isNaN(Date.parse(v))) problems.push(`${owner}.${f.name}: sample is not an ISO date`);
  }
  return problems;
}

export function checkSamples(project) {
  return project.modules.flatMap((m) => (m.sections.interface && m.sections.samples ? sampleProblems(m.name, m.sections.interface.data, m.sections.samples.data) : []));
}

/** Every `rpc://name` string anywhere in the app. */
export function rpcReferences(project) {
  const refs = [];
  const visit = (owner, value) => {
    if (typeof value === 'string') { for (const m of value.matchAll(/rpc:\/\/([^/"\s?]+)/g)) refs.push({ owner, rpc: m[1] }); return; }
    if (value && typeof value === 'object') for (const v of Object.values(value)) visit(owner, v);
  };
  for (const m of project.modules) for (const s of Object.values(m.sections)) visit(s.file, s.data);
  for (const r of project.rpcs) for (const s of Object.values(r.sections)) visit(s.file, s.data);
  for (const s of Object.values(project.webhook.sections)) visit(s.file, s.data);
  return refs;
}

export function checkRpcReferences(project) {
  const names = new Set(project.rpcs.map((r) => r.name));
  const problems = rpcReferences(project).filter((r) => !names.has(r.rpc)).map((r) => `${r.owner}: rpc://${r.rpc} does not exist`);
  const used = new Set(rpcReferences(project).map((r) => r.rpc));
  for (const r of project.rpcs) if (!used.has(r.name)) problems.push(`rpcs/${r.name}: not referenced by any module or webhook`);
  for (const r of project.rpcs) {
    if (!r.sections.api) problems.push(`rpcs/${r.name}: missing api.imljson`);
    const out = r.sections.api?.data?.response?.output;
    if (!out || typeof out.label !== 'string' || typeof out.value !== 'string') problems.push(`rpcs/${r.name}: response.output must be {label, value}`);
    if (!r.sections.api?.data?.response?.iterate) problems.push(`rpcs/${r.name}: response.iterate is missing`);
    const limit = r.sections.api?.data?.response?.limit;
    if (typeof limit !== 'number' || limit < 1 || limit > 500) problems.push(`rpcs/${r.name}: response.limit must be a number from 1 to 500 (Make review requirement)`);
  }
  return problems;
}

export function checkGroups(project) {
  const problems = [];
  const names = new Set(project.modules.map((m) => m.name));
  const grouped = project.groups.data.flatMap((g) => g.modules);
  for (const n of grouped) if (!names.has(n)) problems.push(`groups: unknown module ${n}`);
  for (const n of names) if (!grouped.includes(n)) problems.push(`groups: module ${n} is in no group`);
  const dupes = grouped.filter((n, i) => grouped.indexOf(n) !== i);
  for (const n of dupes) problems.push(`groups: module ${n} is in more than one group`);
  return problems;
}

export function checkUniversal(project) {
  const universal = project.modules.filter((m) => m.meta.typeId === TYPE.UNIVERSAL);
  if (universal.length !== 1) return [`expected exactly one universal module, found ${universal.length}`];
  const api = universal[0].sections.api.data;
  const problems = [];
  if (!String(api.url).startsWith(`${project.base.data.baseUrl}/`)) problems.push(`${universal[0].name}: url must start with the base URL ${project.base.data.baseUrl}`);
  if (!/\{\{parameters\.url\}\}/.test(api.url)) problems.push(`${universal[0].name}: url must append parameters.url`);
  return problems;
}

export function checkSearchLimits(project) {
  const problems = [];
  for (const m of project.modules.filter((x) => x.meta.typeId === TYPE.SEARCH)) {
    const limit = (m.sections.expect?.data ?? []).find((p) => p.name === 'limit');
    if (!limit) problems.push(`${m.name}: search modules need a "limit" parameter`);
    else {
      if (limit.required) problems.push(`${m.name}: limit must not be required in a search module`);
      if (limit.advanced) problems.push(`${m.name}: limit must not be advanced`);
      if (!['uinteger', 'integer', 'number'].includes(limit.type)) problems.push(`${m.name}: limit must be numeric`);
      const params = m.sections.expect.data;
      if (params[params.length - 1]?.name !== 'limit') problems.push(`${m.name}: limit must be the last parameter`);
    }
    const res = m.sections.api.data.response ?? {};
    if (res.limit !== '{{parameters.limit}}') problems.push(`${m.name}: response.limit must be {{parameters.limit}}`);
    if (!res.iterate) problems.push(`${m.name}: search modules need response.iterate`);
  }
  for (const m of project.modules.filter((x) => x.meta.typeId === TYPE.ACTION)) {
    const api = m.sections.api.data;
    if (api.pagination || api.response?.iterate) problems.push(`${m.name}: action modules must not paginate or iterate`);
  }
  return problems;
}

const has = (list, path) => Array.isArray(list) && list.includes(path);
export function checkSanitize(project) {
  const problems = [];
  if (!has(project.base.data.log?.sanitize, 'request.headers.authorization')) problems.push('base: log.sanitize must include request.headers.authorization');
  const conn = project.connection.sections.api?.data;
  if (!has(conn?.log?.sanitize, 'request.headers.authorization')) problems.push('connection/api: log.sanitize must include request.headers.authorization');
  const attach = project.webhook.sections.attach?.data;
  for (const path of ['request.headers.authorization', 'response.body.secret']) if (!has(attach?.log?.sanitize, path)) problems.push(`webhook/attach: log.sanitize must include ${path}`);
  // The API key parameter is a password field.
  const key = (project.connection.sections.parameters?.data ?? []).find((p) => p.name === 'apiKey');
  if (key?.type !== 'password') problems.push('connection/parameters: apiKey must be a password field');
  return problems;
}

export function checkConnectionAndWebhook(project) {
  const problems = [];
  const { connection, webhook, base } = project;
  if (connection.meta.type !== 'apikey') problems.push('connection: type must be apikey');
  const conn = connection.sections.api?.data ?? {};
  if (conn.url !== `${base.data.baseUrl}/api/me`) problems.push('connection/api: must validate with GET /api/me');
  if (conn.response?.metadata?.value !== '{{body.email}}') problems.push('connection/api: metadata must show the account email');
  if (!String(base.data.headers?.Authorization).startsWith('Apikey {{connection.apiKey}}')) problems.push('base: Authorization header must use the connection API key');
  if (webhook.meta.type !== 'web') problems.push('webhook: type must be web (dedicated)');
  const attach = webhook.sections.attach?.data ?? {};
  if (attach.body?.url !== '{{webhook.url}}') problems.push('webhook/attach: must register {{webhook.url}}');
  if (attach.body?.source !== 'make') problems.push('webhook/attach: source must be "make"');
  if (attach.response?.data?.subscriptionId !== '{{body.subscription.id}}') problems.push('webhook/attach: must save subscriptionId from body.subscription.id');
  const detach = webhook.sections.detach?.data ?? {};
  if (!/\{\{webhook\.subscriptionId\}\}/.test(detach.url ?? '') || detach.method !== 'DELETE') problems.push('webhook/detach: must DELETE the saved subscription');
  if (!/body\.event/.test(webhook.sections.api?.data?.condition ?? '')) problems.push('webhook/api: condition must drop payloads without an event');
  if (!project.modules.some((m) => m.meta.webhook)) problems.push('webhook: no instant trigger uses it');
  return problems;
}

export function checkApp(project) {
  const problems = [];
  const { app, icon } = project;
  if (!/^[a-z][a-z0-9-]+$/.test(app.name ?? '')) problems.push('app.json: name must be lowercase letters, digits and hyphens');
  if (!/^#[0-9A-Fa-f]{6}$/.test(app.theme ?? '')) problems.push('app.json: theme must be a #RRGGBB colour');
  for (const k of ['label', 'description', 'language', 'audience']) if (!app[k]) problems.push(`app.json: ${k} is required`);
  const b = icon.bytes;
  const png = b.length > 24 && b.readUInt32BE(0) === 0x89504e47;
  if (!png) problems.push('icon.png: not a PNG');
  else if (b.readUInt32BE(16) !== 512 || b.readUInt32BE(20) !== 512) problems.push('icon.png: must be 512x512');
  if (b.length > 500 * 1024) problems.push('icon.png: must be 500 kB or smaller');
  return problems;
}

export const ALL_CHECKS = {
  checkApp, checkNames, checkLabels, checkModuleSections, checkSamples, checkRpcReferences,
  checkGroups, checkUniversal, checkSearchLimits, checkSanitize, checkConnectionAndWebhook,
};

export function runAllChecks(project) {
  return Object.entries(ALL_CHECKS).flatMap(([name, check]) => check(project).map((p) => `${name}: ${p}`));
}
