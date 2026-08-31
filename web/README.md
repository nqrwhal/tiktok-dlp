# Rewind web app

Rewind is the private, mobile-first media browser and archive dashboard for the
root downloader service.

It is a vinext/Next.js React app with a small archive bridge. The bridge requests
archive rows from the backend's long-lived Store connection, reads saved media
from a read-only mount, serves ordered post assets and package downloads, keeps
the JPEG/ffmpeg thumbnail fallback for legacy videos, and forwards archive
mutations.

## Product surfaces

| Route | Purpose |
| --- | --- |
| `/` | Shuffled full-height feed, bookmarks, creator filter, seek/keyboard playback controls, sharing, and trash |
| `/creator?creator=<id>` | Creator identity and thumbnail video grid |
| `/dashboard` | Archive totals, storage, recent files, and monitoring health |
| `/dashboard/videos` | Search/filter library, feed links, downloads, source links, trash, and restore |
| `/dashboard/media` | Ordered image/video carousels, platform filtering, bookmarks, downloads, and reversible trash/restore for normalized posts |
| `/dashboard/creators` | Creator search/imports, explicit cross-platform profile links, status, and creator-wide trash |
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

Cross-platform creator relationships are managed explicitly on the creator
dashboard. Profile URLs can create or extend a shared creator group, merging
two existing groups requires a separate confirmation, and unlinking preserves
the profile and every saved post. Matching handles never link automatically.

The immersive feed and creator grid remain TikTok/MP4-only. The Media dashboard
is the platform-neutral surface for normalized TikTok, Instagram, and X images,
videos, animated assets, galleries, and mixed posts, with persistent bookmarks
and confirmed trash/restore. Trashed post assets stop serving until restoration;
automatic retention cleanup handles permanent removal without a Media UI action.

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
npm run test:e2e -- --project=desktop-chromium --project=mobile-chromium
```

`npm test` builds the production bundle and checks every rendered route,
critical feed controls, video/post cursor contracts, safe archive paths, ordered
media serving, and live thumbnail-sidecar behavior. The Chromium workflow
covers desktop and mobile navigation, accessibility, mixed-media interactions,
destructive confirmations, and explicit profile linking; CI installs the
browser bundle before running it.

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

- requests creator, video, ordered-post, bookmark, and statistics rows from the long-lived backend Store connection;
- reads `*.info.json` metadata for original descriptions, tags, duration, and
  post dates;
- copies requested videos, images, animations, and packages on demand and serves
  ranged responses where requested;
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
3. a same-origin gateway on port 3000 that routes `/api`, `/media`,
   `/thumbnail`, `/post-media`, and `/post-download` to the bridge and
   everything else to the frontend.

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

The bridge accepts browser `Origin` headers only from the exact
`REWIND_PUBLIC_URL` origin or loopback development origins. That CORS boundary
reduces cross-site access but does not replace the private authentication proxy.

## Browser-facing bridge API

The video, legacy bookmark, and trash contracts below are intentionally
TikTok-only. The post read, bookmark, and lifecycle contracts are
platform-neutral and return normalized creator identity plus ordered assets
without exposing server filesystem paths to the browser.

- `GET /api/health` (backend readiness plus archive-media availability)
- `GET /api/creators`
- `GET /api/videos?creatorId=&username=&fileId=&limit=` (legacy array response)
- `GET /api/videos?page=1&cursor=&creatorId=&username=&fileId=&limit=`
  (`{ items, nextCursor }`, maximum 100 items per page)
- `GET /api/videos?bookmarked=1&limit=5000`
- `GET /api/posts?platform=&username=&profileId=&groupId=&fileId=&cursor=&bookmarked=&trashed=&limit=`
  (`{ items, nextCursor }`, maximum 100 items per page)
- `GET /api/stats`
- `GET /api/bookmarks`
- `POST /api/bookmarks`
- `PUT|DELETE /api/bookmarks/:fileId`
- `PUT|DELETE /api/post-bookmarks/:fileId`
- `DELETE /api/media-posts/:fileId`
- `POST /api/media-posts/:fileId/restore`
- `GET /api/imports?limit=`
- `POST /api/imports`
- `GET /api/imports/:id`
- `POST /api/imports/:id/cancel`
- `POST /api/imports/:id/retry`
- `GET /api/profile-groups`
- `POST /api/profile-groups`
- `PATCH /api/profile-groups/:groupId`
- `DELETE /api/profile-groups/:groupId/profiles/:profileId`
- `GET /api/trash?limit=`
- `DELETE /api/videos/:fileId`
- `POST /api/videos/:fileId/restore`
- `DELETE /api/creators/:username/videos`
- `GET|HEAD /media/:fileId`
- `GET|HEAD /media/:fileId?download=1`
- `GET|HEAD /thumbnail/:fileId.jpg`
- `GET|HEAD /post-media/:fileId/:assetIndex`
- `GET|HEAD /post-download/:fileId`

Creator/video/stat reads and bookmark, import, profile-group, trash, restore,
and deletion mutations use the backend admin API. The bridge does not open the
SQLite database or spawn a SQLite CLI process; only media and legacy metadata
sidecars are read from the archive mount.

## Data flow

`useArchiveData` is the legacy video data boundary and `useArchivePosts` owns
the platform-neutral media pages. When
`NEXT_PUBLIC_ARCHIVE_API_BASE` is configured, it loads real creators, videos,
posts, and stats while exposing explicit loading/error states. Without it, the
development routes use mock video records and an empty media-library state.

Shared UI contracts live in `lib/types.ts`; browser-local playback preferences
live in `lib/playback-preferences.ts`.
