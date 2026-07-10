# Rewind web app

Rewind is the private, mobile-first video browser and archive dashboard for the
root `tiktok-dlp` service.

It is a vinext/Next.js React app with a small archive bridge. The bridge reads
SQLite and saved MP4 files, serves saved JPEG thumbnail sidecars with an ffmpeg
fallback, handles byte-range video responses, and forwards archive mutations to
the backend.

## Product surfaces

| Route | Purpose |
| --- | --- |
| `/` | Shuffled full-height feed, bookmarks, creator filter, seek/keyboard playback controls, sharing, and trash |
| `/creator?creator=<id>` | Creator identity and thumbnail video grid |
| `/dashboard` | Archive totals, storage, recent files, and monitoring health |
| `/dashboard/videos` | Search/filter library, feed links, downloads, source links, trash, and restore |
| `/dashboard/creators` | Creator search, profile imports, status, links, and creator-wide trash |
| `/dashboard/settings` | Browser-local autoplay, sound memory, and default-feed preferences |

The feed preserves original descriptions and hashtags, uses the post date when
a video has no caption, and supports exact video links. Live feed records load
in bounded pages; only seven nearby cards and at most the active and next two
media streams are mounted. Bookmarks are server-backed and existing local
bookmarks migrate once; playback settings remain local to the browser.

The bottom progress bar supports pointer and keyboard seeking. Desktop shortcuts
are Space for play/pause, up/down for navigation, left/right for five-second
seeks, `M` for mute, and `B` for bookmark.

Rewind includes standalone web-app metadata plus regular, maskable, and iOS
icons for Add to Home Screen. It intentionally does not install a service worker
or offline media cache. Immutable videos may use the browser's private HTTP cache.

Creator import jobs are durable: recent progress remains visible with the panel
closed, queued/running jobs can be canceled, failed/canceled jobs can be retried,
and the UI shows at most five item-level failures on demand.

Rewind currently lists MP4 archive records only. Photo/slideshow ZIPs created by
the Discord backend are not part of the web feed.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

The regular development command uses the small mock archive in `lib/mock-data.ts`.

Validation:

```bash
npm run lint
npm test
```

`npm test` builds the production bundle and checks every rendered route,
critical feed controls, cursor contracts, safe archive paths, and the live
thumbnail-sidecar behavior.

## Live preview over SSH

Start the frontend and local bridge together:

```bash
npm run dev:live
```

Defaults:

```text
LIVE_SSH_HOST=yufeihl
LIVE_REMOTE_PROJECT=/home/yufei/tiktok-discord-downloader
LIVE_BRIDGE_PORT=8787
```

Override them in the shell when needed:

```bash
LIVE_SSH_HOST=my-server \
LIVE_REMOTE_PROJECT=/srv/tiktok-dlp \
npm run dev:live
```

The SSH bridge:

- queries the remote SQLite archive;
- reads `*.info.json` metadata for original descriptions, tags, duration, and
  post dates;
- copies requested MP4s on demand and serves HTTP range requests;
- copies existing `.image`, `.jpg`, or `.jpeg` JPEG sidecars before falling
  back to ffmpeg and caches the result under ignored `.live-cache/`;
- forwards creator imports, bookmark updates, and confirmed trash/restore
  requests to the backend.

Those mutation controls affect the connected archive. Keep the preview private
and use confirmation prompts deliberately.

## Production deployment

The root Compose stack builds `Dockerfile.web` and starts `npm run start:live`.
That command runs:

1. the archive bridge on port 8787;
2. the vinext production server on port 3001;
3. a same-origin gateway on port 3000 that routes `/api`, `/media`, and
   `/thumbnail` to the bridge and everything else to the frontend.

The service mounts `data` read-only. Imports and deletions go through the
backend on the private Docker network using `IMPORT_API_TOKEN`.

Set the public origin and start the Cloudflare profile from the repository root:

```env
REWIND_PUBLIC_URL=https://rewind.example.com
IMPORT_API_TOKEN=use-a-long-random-secret
```

```bash
docker compose --profile cloudflare up --build -d
```

> [!WARNING]
> The Rewind bridge exposes live import and archive-mutation routes and has no
> application-level login. Protect the complete hostname with Cloudflare Access
> or an equivalent private authentication proxy.

## Browser-facing bridge API

- `GET /api/health`
- `GET /api/creators`
- `GET /api/videos?creatorId=&username=&fileId=&limit=` (legacy array response)
- `GET /api/videos?page=1&cursor=&creatorId=&username=&fileId=&limit=`
  (`{ items, nextCursor }`, maximum 100 items per page)
- `GET /api/videos?bookmarked=1&limit=5000`
- `GET /api/stats`
- `GET /api/bookmarks`
- `POST /api/bookmarks`
- `PUT|DELETE /api/bookmarks/:fileId`
- `GET /api/imports?limit=`
- `POST /api/imports`
- `GET /api/imports/:id`
- `POST /api/imports/:id/cancel`
- `POST /api/imports/:id/retry`
- `GET /api/trash?limit=`
- `DELETE /api/videos/:fileId`
- `POST /api/videos/:fileId/restore`
- `DELETE /api/creators/:username/videos`
- `GET|HEAD /media/:fileId`
- `GET|HEAD /media/:fileId?download=1`
- `GET|HEAD /thumbnail/:fileId.jpg`

Creator/video/stat reads come directly from the active archive and omit trashed
records. Bookmark, import, trash, restore, and deletion mutations are forwarded
to the backend admin API.

## Data flow

`useArchiveData` is the live frontend data boundary. When
`NEXT_PUBLIC_ARCHIVE_API_BASE` is configured, it loads real creators, videos,
and stats independently, retains the last valid live data during refresh errors,
and exposes explicit loading/error states. Without it, the development routes
use mock records.

Shared UI contracts live in `lib/types.ts`; browser-local playback preferences
live in `lib/playback-preferences.ts`.
