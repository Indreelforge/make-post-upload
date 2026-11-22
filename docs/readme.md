# Post-Upload

[Post-Upload](https://post-upload.com) publishes videos, photos and text to 22 platforms with one API call: Instagram, YouTube, TikTok, Facebook, X, LinkedIn, Threads, Pinterest, Reddit, Google Business Profile, Bluesky, Discord, Telegram, Slack, Mastodon, WordPress, Dev.to, Hashnode, Lemmy, Nostr, Whop and Listmonk.

## Connect Post-Upload to Make

1. Sign in to Post-Upload and turn on two-factor authentication.
2. Open [Dashboard → API Keys](https://post-upload.com/dashboard/api-keys) and create an API key.
3. In Make, add any Post-Upload module, click **Add** next to **Connection** and paste the key.

Make checks the key with `GET /api/me` and shows the account email as the connection name.

## Before you post

Create a profile for each brand or client, then connect its social accounts in the [Post-Upload dashboard](https://post-upload.com/dashboard/users), or send your client a link from **Create a client connect link**.

Some networks need extra options:

| Network | Option |
| --- | --- |
| TikTok | **TikTok privacy** is required. |
| Pinterest | **Pinterest board** is required. |
| Reddit | **Subreddit** is required. |
| YouTube | **YouTube privacy** (default public). |
| Facebook, LinkedIn, Google Business Profile | Pick the page or location to post to. |
| Dev.to, Hashnode, Lemmy, Listmonk | **Title or caption** is the article title, post title or email subject; **Description** is the Markdown body. Optional **Dev.to tags** and **Lemmy link**. |
| Listmonk | Every post emails your connected lists right away. Turn on **Listmonk draft** to create the campaign as a draft instead. |

Any other API option (`youtube_tags`, `pinterest_link`, `reddit_flair_id` …) goes into **Other platform options**. The [platform guides](https://docs.post-upload.com/platform-guides/tiktok) list them.

## Uploads run in the background

The upload modules return an upload ID straight away. Use **Watch upload events** (instant) or **Get an upload status** to learn the result on each network.

## Watch upload events

**Watch upload events** registers a webhook subscription in Post-Upload when you create the webhook in Make and deletes it when you delete the webhook. Choose the events and, optionally, one profile. It needs the Post-Upload Advanced plan or higher. A published scheduled post sends **Scheduled post published**, not **Upload completed**.

Each webhook URL is unique and secret. Post-Upload also signs every delivery (`X-Post-Upload-Signature`), but Make cannot check the signature, so do not share the webhook URL.

## Make an API call

Calls any endpoint of the [Post-Upload API](https://docs.post-upload.com/api-reference/authentication) with your connection. Enter a path such as `/api/me`.

## Help

Documentation: https://docs.post-upload.com · Support: https://post-upload.com/dashboard/support
