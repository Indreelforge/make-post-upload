// Renders the IML templates with a minimal evaluator (test/helpers/iml.mjs) and checks the
// resulting requests: Zapier-equal upload bodies, omitted empty fields, platform options,
// webhook lifecycle and receiver, RPC labels and pagination. Not Make's engine: see the helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject, ROOT } from '../scripts/lib/project.mjs';
import { evaluate, mappedParameters, render } from './helpers/iml.mjs';

const project = loadProject();
const api = (name) => project.modules.find((m) => m.name === name).sections.api.data;
const rpc = (name) => project.rpcs.find((r) => r.name === name).sections.api.data;
const zapierExample = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/zapier-reference.json'), 'utf8'))._zapierUploadBodyExample;

// The Zapier example input, as a Make user would map it (dates arrive as dates).
const full = mappedParameters({
  profile: zapierExample.input.profile,
  platforms: zapierExample.input.platforms,
  title: zapierExample.input.title,
  description: zapierExample.input.description,
  schedule: new Date(zapierExample.input.schedule),
  timezone: zapierExample.input.timezone,
  add_to_queue: zapierExample.input.add_to_queue,
  first_comment: zapierExample.input.first_comment,
  reference: zapierExample.input.reference,
});
const minimal = mappedParameters({ profile: 'my-brand', platforms: ['instagram'], title: 'Hello', description: '', timezone: '', platform_options: [] });

test('Upload a video sends the same body as the Zapier app', () => {
  const body = render(api('uploadVideo').body, { parameters: { ...full, video_url: 'https://cdn.example.com/v.mp4' } });
  assert.deepEqual(body, { ...zapierExample.body, video_url: 'https://cdn.example.com/v.mp4' });
});

test('Upload photos and Create a text post send the same body as the Zapier app', () => {
  const photos = ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'];
  assert.deepEqual(render(api('uploadPhotos').body, { parameters: { ...full, photo_urls: photos } }), { ...zapierExample.body, photo_urls: photos });
  assert.deepEqual(render(api('createTextPost').body, { parameters: full }), zapierExample.body);
});

test('empty optional fields are omitted', () => {
  const body = render(api('uploadVideo').body, { parameters: { ...minimal, video_url: 'https://cdn.example.com/v.mp4' } });
  assert.deepEqual(body, { user: 'my-brand', platforms: ['instagram'], title: 'Hello', async_upload: true, video_url: 'https://cdn.example.com/v.mp4' });
});

test('platform options are sent as top-level API fields', () => {
  const parameters = { ...minimal, privacy_level: 'SELF_ONLY', pinterest_board_id: '987', platform_options: [{ key: 'youtube_tags', value: 'launch,demo' }, { key: 'reddit_nsfw', value: 'false' }] };
  const body = render(api('uploadVideo').body, { parameters: { ...parameters, video_url: 'https://cdn.example.com/v.mp4' } });
  assert.equal(body.privacy_level, 'SELF_ONLY');
  assert.equal(body.pinterest_board_id, '987');
  assert.equal(body.youtube_tags, 'launch,demo');
  assert.equal(body.reddit_nsfw, 'false');
  const text = render(api('createTextPost').body, { parameters: { ...minimal, reddit_subreddit: 'test' } });
  assert.equal(text.reddit_subreddit, 'test');
});

test('file uploads send multipart text parts and the file part', () => {
  const data = Buffer.from('fake video');
  const body = render(api('uploadVideoFile').body, { parameters: { ...minimal, video_name: 'launch.mp4', video_data: data } });
  assert.equal(api('uploadVideoFile').type, 'multipart/form-data');
  assert.deepEqual(body.video, { value: data, options: { filename: 'launch.mp4' } });
  assert.equal(body.async_upload, 'true');
  assert.equal(body.add_to_queue, 'false');
  assert.deepEqual(body.platforms, ['instagram']);
  const photo = render(api('uploadPhotoFile').body, { parameters: { ...minimal, add_to_queue: true, photo_name: 'p.jpg', photo_data: data } });
  assert.deepEqual(photo['photos[]'], { value: data, options: { filename: 'p.jpg' } });
  assert.equal(photo.add_to_queue, 'true');
});

test('Update a scheduled post sends only the fields that are set', () => {
  const a = api('updateScheduledPost');
  assert.deepEqual(render(a.body, { parameters: { job_id: 'upl_1', title: 'New' } }), { title: 'New' });
  assert.deepEqual(render(a.body, { parameters: { job_id: 'upl_1', scheduled_date: new Date('2026-12-24T18:00:00Z'), timezone: 'Europe/Paris' } }), { scheduled_date: '2026-12-24T18:00:00+00:00', timezone: 'Europe/Paris' });
  assert.equal(render(a.url, { parameters: { job_id: 'upl_1' } }), '/api/schedule/upl_1');
});

test('Update queue settings sends the full replacement body', () => {
  const body = render(api('updateQueueSettings').body, { parameters: { profile: 'my-brand', timezone: 'UTC', slots: ['09:00', '17:30'], days_of_week: [1, 3, 5], max_posts_per_slot: 2 } });
  assert.deepEqual(body, { profile_username: 'my-brand', timezone: 'UTC', slots: ['09:00', '17:30'], days_of_week: [1, 3, 5], max_posts_per_slot: 2 });
});

test('the webhook attach registers the Make URL and omits an empty profile', () => {
  const attach = project.webhook.sections.attach.data;
  const ctx = (parameters) => ({ parameters, webhook: { url: 'https://hook.eu1.make.com/abc', id: 7 } });
  const all = render(attach.body, ctx({ events: ['upload.completed', 'upload.failed'] }));
  assert.deepEqual(all, { url: 'https://hook.eu1.make.com/abc', events: ['upload.completed', 'upload.failed'], name: 'Make: Watch upload events', source: 'make' });
  assert.equal(render(attach.body, ctx({ events: ['upload.partial'], profile: 'my-brand' })).profile, 'my-brand');
  assert.deepEqual(render(attach.response.data, { body: { success: true, subscription: { id: 'whs_1a2b' }, secret: 's' } }), { subscriptionId: 'whs_1a2b' });
  const detach = project.webhook.sections.detach.data;
  assert.equal(render(detach.url, { webhook: { subscriptionId: 'whs_1a2b' } }), '/api/webhooks/subscriptions/whs_1a2b');
});

test('the webhook receiver drops payloads without an event and hides user_id', () => {
  const receiver = project.webhook.sections.api.data;
  const accepts = (body) => render(receiver.condition, { body });
  assert.equal(accepts({}), false);
  assert.equal(accepts({ event: '' }), false);
  assert.equal(accepts({ event: 'upload.completed' }), true);
  assert.equal(accepts({ event: 'test' }), true);
  const out = render(receiver.output, { body: { event: 'upload.failed', upload_id: 'upl_1', user_id: '42', data: { title: 'x' } } });
  assert.deepEqual(out, { event: 'upload.failed', upload_id: 'upl_1', data: { title: 'x' } });
});

test('requests authenticate with the connection API key and errors show the API message', () => {
  const base = project.base.data;
  assert.equal(render(base.headers.Authorization, { connection: { apiKey: 'k_test' } }), 'Apikey k_test');
  assert.equal(render(project.connection.sections.api.data.headers.Authorization, { parameters: { apiKey: 'k_test' } }), 'Apikey k_test');
  assert.equal(render(base.response.error.message, { statusCode: 400, body: { error: 'Platform(s) not connected: tiktok', error_code: 'PLATFORM_NOT_CONNECTED' } }), '[400] Platform(s) not connected: tiktok (PLATFORM_NOT_CONNECTED)');
  assert.equal(render(base.response.error.message, { statusCode: 404, body: { error: 'Upload not found' } }), '[404] Upload not found');
  assert.equal(render(project.connection.sections.api.data.response.metadata.value, { body: { email: 'team@example.com' } }), 'team@example.com');
});

test('RPC dropdown labels render for real response items', () => {
  const uploads = rpc('getUploads').response.output;
  assert.deepEqual(render(uploads, { item: { id: 'upl_1', title: null, profile_name: 'my-brand', status: 'failed' } }), { label: '(no caption) · my-brand · failed', value: 'upl_1' });
  const scheduled = rpc('getScheduledPosts').response.output;
  assert.equal(render(scheduled.label, { item: { title: 'Launch', scheduled_at: '2026-12-01T09:30:00.000Z' } }), 'Launch · 2026-12-01 09:30');
  assert.deepEqual(render(rpc('getProfiles').response.output, { item: { name: 'acme', locked: true } }), { label: 'acme (locked)', value: 'acme' });
  assert.equal(render(rpc('getTiktokPrivacyLevels').response.output.label, { item: 'SELF_ONLY' }), 'Only me');
  assert.equal(render(rpc('getTiktokPrivacyLevels').response.output.label, { item: 'NEW_LEVEL' }), 'NEW_LEVEL');
  assert.equal(render(rpc('getPinterestBoards').qs.profile, { parameters: { profile: 'acme' } }), 'acme');
});

test('Search uploads filters by profile and paginates until the last page', () => {
  const a = api('searchUploads');
  const keep = (parameters, item) => render(a.response.iterate.condition, { parameters, item });
  assert.equal(keep({}, { profile_name: 'a' }), true);
  assert.equal(keep({ profile: 'a' }, { profile_name: 'a' }), true);
  assert.equal(keep({ profile: 'a' }, { profile_name: 'b' }), false);
  assert.equal(render(a.pagination.condition, { body: { pagination: { pages: 3 } }, pagination: { page: 2 } }), true);
  assert.equal(render(a.pagination.condition, { body: { pagination: { pages: 3 } }, pagination: { page: 4 } }), false);
  const deliveries = api('listWebhookDeliveries');
  assert.equal(render(deliveries.pagination.condition, { body: { deliveries: new Array(100).fill({}) } }), true);
  assert.equal(render(deliveries.pagination.condition, { body: { deliveries: [{}] } }), false);
});

test('Make an API call targets the Post-Upload host with the user path', () => {
  const a = api('makeApiCall');
  const ctx = { parameters: { url: '/api/me', method: 'GET', headers: [{ key: 'X-Test', value: '1' }], qs: [{ key: 'limit', value: '5' }] } };
  assert.equal(render(a.url, ctx), 'https://api.post-upload.com//api/me');
  assert.deepEqual(render(a.headers, ctx), { 'X-Test': '1' });
  assert.deepEqual(render(a.qs, ctx), { limit: '5' });
});

test('every IML expression in the app parses with the test evaluator', () => {
  const failures = [];
  const visit = (owner, value) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        if (m[1] === '...') continue;
        try { evaluate(m[1], new Proxy({}, { has: () => true, get: () => undefined })); } catch (e) { if (!/unknown variable/.test(e.message)) failures.push(`${owner}: ${e.message}`); }
      }
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { visit(owner, k); visit(owner, v); }
  };
  for (const m of project.modules) visit(m.name, m.sections.api.data);
  for (const r of project.rpcs) visit(r.name, r.sections.api.data);
  for (const s of Object.values(project.webhook.sections)) visit(s.file, s.data);
  visit('base', project.base.data);
  visit('connection', project.connection.sections.api.data);
  assert.deepEqual(failures, []);
});

test('gateway errors with a text body get a readable message', () => {
  const error = project.base.data.response.error;
  // Cloudflare answers 502/503/504 with a text page, not the API's JSON.
  assert.equal(render(error['502'].message, { statusCode: 502, body: { success: undefined } }), '[502] Post-Upload is temporarily unavailable (bad gateway). Try again in a few minutes.');
  assert.equal(render(error['502'].message, { statusCode: 502, body: { success: false, message: 'Your endpoint did not accept the test event (404).' } }), '[502] Your endpoint did not accept the test event (404).');
  assert.match(error['503'].message, /^\[503\] Post-Upload is temporarily unavailable/);
  assert.match(project.connection.sections.api.data.response.error['504'].message, /^\[504\]/);
});
