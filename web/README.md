# Rewind frontend

Mobile-first video browsing and archive management for `tiktok-dlp`.

## What is included

- `/` — a full-height, scroll-snap video feed optimized for touch
- `/dashboard` — archive health, storage, and recent downloads
- `/dashboard/videos` — searchable video library with bulk-selection UI
- `/dashboard/creators` — creator monitoring controls
- `/dashboard/settings` — playback, download, and retention preferences
- `lib/archive-api.ts` — the frontend data boundary for the backend API

The regular development build uses safe mock records and a public CC0 demo
video. Dashboard mutations are intentionally preview-only until the backend API
is ready.

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
SSH. Requested MP4 files are copied into the ignored `.live-cache/` directory
on demand and served locally with HTTP byte-range support. It does not modify or
restart the backend server.

## Backend integration contract

Replace `mockArchiveApi` with an implementation of `ArchiveApi` backed by:

- `GET /api/creators`
- `GET /api/videos?creatorId=&cursor=&limit=`
- `GET /media/:fileId` with HTTP range support

The shared frontend types live in `lib/types.ts`.
