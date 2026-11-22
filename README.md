# Post-Upload for Make

A native [Make](https://www.make.com) custom app for [Post-Upload](https://post-upload.com): publish videos, photos and text to 22 platforms, schedule posts, manage profiles and react to upload events.

The source is plain Make component files (`.imljson`), uploaded with the official TypeScript SDK [`@makehq/sdk`](https://www.npmjs.com/package/@makehq/sdk) 1.8.1.

## Modules

| Group | Modules |
| --- | --- |
| Triggers | Watch upload events (instant) |
| Posts | Upload a video, Upload a video file, Upload photos, Upload a photo file, Create a text post, Search uploads, Get an upload, Get an upload status, Retry a failed upload, Delete an upload |
| Scheduling | List scheduled posts, Update a scheduled post, Cancel a scheduled post, List queue slots, Get the next queue slot, Get queue settings, Update queue settings |
| Profiles | List profiles, Get a profile, Get connected accounts, Get TikTok creator info, Create a profile, Create a client connect link, Create a platform connect link, Disconnect a platform, Delete a profile |
| Platforms | List Facebook pages, List LinkedIn pages, List Pinterest boards, List Google Business locations, Search published posts |
| Analytics and account | Get an analytics overview, Get profile analytics, Get account details, Get platform limits, Get the X post allowance, Get the YouTube upload allowance |
| Webhooks | Get webhook settings, Update webhook settings, Send a test webhook event, List webhook deliveries |
| Other | Make an API call |

Dropdowns are filled by RPCs: profiles, recent/failed uploads, scheduled posts, Facebook pages, LinkedIn pages, Pinterest boards, Google Business locations and TikTok privacy levels.

## Layout

```
app.json                  app metadata (name, label, theme, audience)
base.imljson              base URL, API key header, error message, log sanitization
groups.imljson            module groups shown in Make
docs/readme.md            app documentation shown in Make
icon.png                  512×512 logo (black = white on the theme colour, transparent = theme colour)
connection/               API key connection (validated with GET /api/me)
webhook/                  dedicated attached webhook: attach / detach / receiver / parameters
modules/<name>/           metadata.json + api, parameters, expect, interface, samples
rpcs/<name>/              metadata.json + api (+ parameters)
scripts/upload.mjs        uploader (--dry-run | --live)
test/                     offline tests (node:test)
```

## Develop

```bash
npm ci
npm test                 # offline: structure, naming, OpenAPI contract, Zapier parity, editor schemas, IML smoke, uploader
npm run upload:dry-run   # static checks + full upload sequence against an in-memory mock, twice
```

`npm test` makes no network request. The API contract is checked against `test/fixtures/openapi.json`; refresh it with `npm run sync:openapi` (downloads `https://api.post-upload.com/openapi.json`) or `npm run sync:openapi -- ../indreelforge/backend/public/openapi.json`. To check against another copy without saving it: `POST_UPLOAD_OPENAPI=/path/to/openapi.json npm test`.

## Upload to Make

1. In Make, open your avatar → **Profile** → **API** → **Add token**. Give it the scopes **`sdk-apps:read`** and **`sdk-apps:write`**, save, and copy the token. Tokens are per zone: create it in the zone (for example `eu1.make.com`) where the app should live.
2. Create `.env.local` in this folder (it is git-ignored) from `.env.example`:

   ```
   MAKE_API_KEY=<your token>
   MAKE_ZONE=eu1.make.com
   ```

3. Run:

   ```bash
   npm ci
   npm run upload
   ```

The uploader runs the static checks, then creates the app as a **private** app (or updates it), the connection, the 9 RPCs, the webhook, the 43 modules and the groups. It reads back every section it writes and compares it with the source. It is idempotent: run it again after any change. The names Make assigns to the connection and webhook are cached in `.make-state.json` (git-ignored). It retries only on HTTP 429 and never prints the token, section source or API error bodies.

It never publishes the app, changes module visibility or requests a review. Do that in Make when you are ready.

### After uploading

1. In Make, open **Custom apps → Post-Upload** and create a scenario with one of its modules.
2. Add a connection: paste a Post-Upload API key from [Dashboard → API Keys](https://post-upload.com/dashboard/api-keys).
3. Test the dropdowns (profiles, Pinterest boards …), an upload, and **Watch upload events** (create the webhook, run the scenario once, then trigger an upload or use **Send a test webhook event**).

## Live verification (us1, app `post-upload-ro489y` v1, 2026-11-21)

Run through the Make API with a real Post-Upload connection, posting only to a Discord-only test profile:

- All 9 RPCs return options (profile-dependent ones return the API's "not connected" message when the profile lacks that network).
- Test scenarios named `Post-Upload test: …` (left in the account, OFF) run every module: read-only modules, searches (limit respected), a throwaway profile lifecycle (create, queue settings, connect links, disconnect, delete), text/photo/video posting by URL and by file, schedule → update → cancel, a failing upload → retry, delete, error messages, and the webhook lifecycle.
- Creating the webhook in Make registers a Post-Upload subscription (`subscriptionId` saved); deleting it removes the subscription. A subscription test event reaches Make and runs **Watch upload events**.
- Not run live, by design: **Update webhook settings** (it replaces the account's real webhook settings).

To create the instant-trigger hook through the Make API, use `typeName: "app#<app name>"` and put the webhook parameters plus `__IMTCONN__` in `data`. Blueprint module ids are `app#<app name>:<module>`.

## Review checklist (Make app review prerequisites)

Done: sanitization and error handling in base and connection; connection validated against `/api/me`; sentence-case labels and descriptions; one universal module; interfaces and samples for every module; dates formatted (`formatDate`) and parsed (`date` interface fields); `limit` on every search and RPC; pagination where the API pages (uploads, webhook deliveries); test scenarios covering every module plus an error scenario.

Before requesting review: run the test scenarios again right before submitting (logs expire); pagination logs need more than 100 uploads (page size 100); check the logs contain no personal data you do not want reviewers to see (Get account details shows the account email); confirm support contact, categories and trademark/T&C declarations in Make's review form. Publishing is permanent and done by the owner in Make.

## Notes

- **Instant trigger.** One **Watch upload events** module with an event choice in the webhook dialog. Make binds each instant trigger to one webhook definition, and the subscription is registered when the webhook is created, so the event filter belongs to the webhook. One module and one webhook cover all four events instead of four near-identical webhook definitions.
- **Webhook signatures.** Post-Upload signs deliveries with HMAC-SHA256 (`X-Post-Upload-Signature`), but Make IML cannot verify an HMAC over the raw body. The app relies on the secret per-hook URL (logged URLs are sanitized) and drops payloads without an `event`.
- **Files.** Upload a video file / Upload a photo file send `multipart/form-data` with the file part (`video`, `photos[]`). Multiple photos as files are not offered: use Upload photos with URLs.
- **Video tools** (FFmpeg trim/resize/convert) are not included: the result download endpoint is not in the API contract. Use Make an API call.

## License

MIT. `test/editor-schemas/` are Make's editor schemas from [integromat/vscode-apps-sdk](https://github.com/integromat/vscode-apps-sdk) under their own licence (`test/editor-schemas/LICENSE.md`).
