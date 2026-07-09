# Rewind frontend

Mobile-first video browsing and archive management for `tiktok-dlp`.

## What is included

- `/` — a full-height, scroll-snap video feed optimized for touch
- `/dashboard` — archive health, storage, and recent downloads
- `/dashboard/videos` — searchable video library with bulk-selection UI
- `/dashboard/creators` — creator monitoring controls and full-profile imports
- `/dashboard/settings` — playback, download, and retention preferences
- `lib/archive-api.ts` — the frontend data boundary for the backend API

The regular development build uses safe mock records and a public CC0 demo
video. Creator imports use the live backend API; other dashboard mutations are
still preview-only.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm test
```

## Live local preview

If the SSH alias `yufeihl` is available, start the frontend and its local
read-only data bridge together:

```bash
npm run dev:live
```

The bridge reads creators and video records from the live SQLite database over
SSH. It also reads the saved `*.info.json` sidecars so the frontend preserves
the original captions, hashtags, duration, and post date. Captionless items use
their post date instead of generated titles.

Thumbnails are extracted from the archived MP4s on the server and cached in the
ignored `.live-cache/` directory. Requested MP4 files are copied on demand and
served locally with HTTP byte-range support. Creator import requests are
forwarded over SSH to the backend's loopback-only admin API; the bridge does not
write the archive database itself or restart the backend server.

## Backend integration contract

Replace `mockArchiveApi` with an implementation of `ArchiveApi` backed by:

- `GET /api/creators`
- `GET /api/videos?creatorId=&cursor=&limit=`
- `POST /api/imports`
- `GET /api/imports?limit=`
- `GET /api/imports/:id`
- `GET /thumbnail/:fileId.jpg`
- `GET /media/:fileId` with HTTP range support

The shared frontend types live in `lib/types.ts`.

## Server deployment

The root Compose stack includes a `rewind-web` service for the private hosted
archive. It reads the mounted archive database and media directory directly,
serves the production frontend, and proxies all browser-facing archive routes
through one origin. The data mount is read-only; creator imports are sent to the
backend over the private Docker network with `IMPORT_API_TOKEN`.

Set `REWIND_PUBLIC_URL` if the archive is hosted somewhere other than
`https://rewind.yufei.dev`, then start the normal Cloudflare profile:

```bash
docker compose --profile cloudflare up --build -d
```
