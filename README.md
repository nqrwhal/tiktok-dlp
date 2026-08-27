# tiktok-dlp

Self-hosted TikTok downloader and archive with Discord monitoring, full-profile
imports, and **Rewind**: a private, mobile-first feed and dashboard for watching
and managing saved videos.

The backend uses `yt-dlp`, ffmpeg, Node.js, SQLite, and filesystem storage. The
Rewind web app adds a touch-first video feed, creator galleries, archive search,
imports, downloads, trash/restore controls, and an installable mobile shell.
Docker Compose runs both
surfaces, while Cloudflare Tunnel can expose tokenized downloads and a
Cloudflare Access-protected archive.

> [!IMPORTANT]
> Optional Netscape cookies authenticate as a real TikTok account so the bot can
> archive follower-only / friends-only posts that account can already watch. They
> do not bypass private accounts, deleted content, paywalls, or other permissions
> the account does not have. Unset cookies keep public-only behavior. Make sure
> your use complies with the platform's terms and applicable law.

## Features

### Discord downloader and monitor

- Downloads TikTok videos from slash commands, DMs, and up to three URLs
  in a Discord message. With `YTDLP_COOKIES_FILE` set, this includes
  follower-only / friends-only posts the cookie account can already watch.
- Handles public photo/slideshow posts with a direct fallback and ZIP output.
  Configured cookies and the yt-dlp proxy are applied to those HTTP fallbacks.
- Performs best-effort story discovery and downloads, including an authenticated
  session when cookies are configured.
- Monitors creators on a per-server or per-DM subscription basis.
- Detects creator username changes and reports when saved source posts disappear.
- Uses a bounded, deduplicated download queue with per-user and per-server limits.
- Reuses immutable saved assets instead of downloading the same post repeatedly.
- Delivers small files through Discord and larger files through tokenized links.
- Supports temporary links, extensions, permanent retention, history, and purge.

### Creator imports and archive management

- Imports an entire creator profile through the dashboard or admin API.
  Friends-only items yt-dlp can extract for the cookie account are included.
- Skips already saved posts and videos above an adjustable duration limit.
- Persists per-video import checkpoints, resumes interrupted jobs after restart,
  and supports cooperative cancellation and retry.
- Strictly skips videos above the selected duration and items whose duration
  remains unknown after metadata lookup.
- Stores archive state in SQLite and media under `data/downloads`.
- Moves individual videos or a creator's saved videos to restorable trash with
  explicit confirmation and configurable delayed purging.

### Rewind web app

- Full-height, scroll-snap video feed optimized for mobile playback.
- Fresh shuffled ordering per visit, plus an explicit Shuffle action.
- All and server-backed Bookmarks feeds with creator filtering and automatic
  one-time migration of existing browser bookmarks.
- Original captions and hashtags, a post-date fallback for captionless videos,
  creator links, and source links.
- Bounded cursor pages, seven-card rendering, two-video lookahead after the
  active frame starts, saved thumbnail reuse, and exact-video deep links.
- Seekable progress, remembered sound, autoplay control, guarded desktop
  shortcuts, and a one-time touch-control hint.
- Creator profile pages with thumbnail grids that jump directly into the feed.
- Searchable video library with thumbnails, creator filters, downloads, source
  links, trash inspection, and restore.
- Creator dashboard with persistent import progress, monitoring status,
  profile/library shortcuts, and typed-confirmation bulk trash.
- Installable standalone metadata and mobile icons without an offline service
  worker; immutable media may use the device's private HTTP cache.
- Responsive, keyboard-aware navigation, menus, dialogs, and recovery states.

Rewind currently indexes archived MP4 records. Photo/slideshow ZIPs delivered by
the Discord bot are not shown in its video feed.

## Architecture

```mermaid
flowchart LR
    TikTok[TikTok content] --> Media[yt-dlp + ffmpeg]
    Discord[Discord] <--> Backend[Node backend]
    Media --> Backend
    Backend <--> State[(SQLite + data/downloads)]
    Rewind[Rewind web + archive bridge] --> State
    Rewind -->|imports, trash, and restore| Backend
    Tunnel[Cloudflare Tunnel] --> Backend
    Access[Cloudflare Access] --> Rewind
```

The backend owns Discord, monitoring, imports, retention, and durable
archive mutations. Rewind mounts the archive data read-only, derives creators,
videos, thumbnails, and statistics, and forwards authorized archive mutations
to the backend over the private Docker network.

## Requirements

Recommended production setup:

- Docker Engine with Docker Compose
- A Discord application and bot token
- A public hostname for tokenized Discord downloads
- A private hostname for Rewind, protected by Cloudflare Access or an equivalent
  authentication layer

For direct local development:

- Node.js `>=22.13.0`
- `yt-dlp` and ffmpeg for backend download work
- SQLite CLI, Python 3, and ffmpeg for the live Rewind bridge

## Quick start with Docker

1. Clone the repository and prepare the environment:

   ```bash
   git clone https://github.com/nqrwhal/tiktok-dlp.git
   cd tiktok-dlp
   cp .env.example .env
   ```

2. Set the required values in `.env`:

   ```env
   DISCORD_TOKEN=...
   DISCORD_CLIENT_ID=...
   PUBLIC_BASE_URL=https://downloads.example.com
   REWIND_PUBLIC_URL=https://rewind.example.com
   IMPORT_API_TOKEN=use-a-long-random-secret
   ```

   `IMPORT_API_TOKEN` protects the backend admin hop used by the Rewind service.
   Generate a secret with a password manager or a command such as
   `openssl rand -hex 32`.

3. Register the global Discord commands:

   ```bash
   npm install
   npm run register:commands
   ```

   Alternatively, set `REGISTER_COMMANDS_ON_START=true` for the first backend
   start, then turn it off after registration succeeds.

4. Start the backend and Rewind services:

   ```bash
   docker compose up --build -d
   docker compose logs -f
   ```

Compose uses `expose`, not host-published `ports`; the services remain available
only inside the Docker network. Use the Cloudflare profile, another reverse
proxy, or an explicit local Compose override to reach them from outside it.

Persistent state and downloads live under `./data`. Optional TikTok cookies can
be mounted from `./cookies`.

## Cloudflare Tunnel and private access

Configure two public hostnames on the same tunnel:

```text
downloads.example.com -> http://tiktok-discord-downloader:8080
rewind.example.com    -> http://rewind-web:3000
```

- Set `PUBLIC_BASE_URL` to the download hostname.
- Set `REWIND_PUBLIC_URL` to the Rewind hostname.
- Protect the entire Rewind hostname with Cloudflare Access. Rewind includes
  live import and destructive deletion routes and does not provide its own
  application login.

Add the tunnel token to `.env`, prepare the Docker secret, and start the profile:

```env
CLOUDFLARE_TUNNEL_TOKEN=...
```

```bash
npm run prepare:tunnel
docker compose --profile cloudflare up --build -d
```

The preparation script writes `.secrets/cloudflare_tunnel_token` with restricted
permissions. Only the `cloudflared` container receives that secret.

Health endpoints:

```bash
curl https://downloads.example.com/health
curl https://rewind.example.com/api/health
```

The second request must satisfy the private access policy.

## Discord commands

- `/download url:<tiktok-url> delivery:auto|file|link`
- `/watch add username:<username>`
- `/watch remove username:<username>`
- `/watch list`
- `/watch run username:<username>`
- `/status`
- `/history`
- `/downloads list limit:<1-25> username:<username>`
- `/downloads purge scope:mine|all confirm:PURGE`

The bot also reacts to TikTok URLs in readable guild channels and DMs. For
message-based help, use `tiktok help`, `!tiktok help`, mention the bot with
`help`, or DM it `help`.

The bot requires the `Guilds`, `Guild Messages`, `Direct Messages`, and
`Message Content` intents. Enable Message Content in the Discord developer
portal.

Watch management requires Manage Server, `WATCH_MANAGER_ROLE_ID`, or
`DISCORD_OWNER_ID` in DMs. Watches are subscribed per guild/DM, so multiple
destinations can follow one creator without duplicating the underlying scan.

## Rewind routes

| Route | Purpose |
| --- | --- |
| `/` | Shuffled mobile video feed and bookmarks |
| `/creator?creator=<id>` | Creator profile and saved-video grid |
| `/dashboard` | Archive totals, storage, recent files, and monitor health |
| `/dashboard/videos` | Search, filter, play, download, trash, and restore videos |
| `/dashboard/creators` | Search creators, import profiles, and move creator archives to trash |
| `/dashboard/settings` | Browser-local playback and default-feed preferences |

Bookmarks are stored in the archive database and playback preferences remain in
the current browser. Existing local bookmarks migrate once on the next visit.
Archive files, imports, trash, and restore operations are server-backed.

## Creator imports

Start an import through the Rewind creator dashboard or the backend API:

```http
POST /api/imports
Authorization: Bearer <IMPORT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "username": "creator",
  "maxDurationSeconds": 120
}
```

The backend enumerates the profile yt-dlp can extract for the configured
session, skips existing files, skips
videos above the selected limit, and downloads the remaining posts as permanent
archive files. It checkpoints every item in SQLite, resumes interrupted imports,
and still attempts items whose duration remains unknown (photo posts often
report none) so the photo resolver can save them as slideshow ZIPs. The
supported per-import duration range is 1–3600 seconds.

Read progress with `GET /api/imports?limit=20` or `GET /api/imports/:id`.
Cancel or retry eligible jobs with `POST /api/imports/:id/cancel` and
`POST /api/imports/:id/retry`. Cancellation is cooperative: an in-flight TikTok
request finishes before the job stops.

## Photo/slideshow resolver

Follower-only photo posts are app-gated on the `/photo/{id}` web route, but the
authenticated session can still read them from the `/video/{id}` page and the
unsigned `www.tiktok.com/api/item/detail` endpoint. `src/tiktok/photoResolver.js`
implements that chain (desktop video page → item detail API → legacy mobile-UA
fetch) and `src/tiktok/ytdlp.js` uses it whenever yt-dlp cannot produce a
playable video file. No app-request signing or device registration is involved.

A standalone CLI is available inside the app container for debugging:

```bash
docker compose exec tiktok-discord-downloader node src/tiktok/photo-resolve-cli.js \
  --cookies /app/data/tiktok-cookies.txt --proxy http://gluetun:8888 \
  --url 'https://www.tiktok.com/@user/photo/7636317293982649631'
```

It prints the resolver contract as JSON (`ok`, `awemeId`, `username`,
`createTime`, `durationSeconds`, `audioUrl`, `coverUrl`, and `images[]` with
direct image URLs plus dimensions) and exits non-zero when the post cannot be
resolved (`no_access`, `no_images`, or `not_found`). Cookie values are never
logged.

## HTTP surfaces

Backend:

- `GET|HEAD /health`
- `GET|HEAD /files/:token`
- `GET /api/imports?limit=`
- `POST /api/imports`
- `GET /api/imports/:id`
- `POST /api/imports/:id/cancel`
- `POST /api/imports/:id/retry`
- `GET /api/trash?limit=`
- `GET /api/bookmarks`
- `POST /api/bookmarks`
- `PUT|DELETE /api/bookmarks/:fileId`
- `DELETE /api/videos/:fileId`
- `POST /api/videos/:fileId/restore`
- `DELETE /api/creators/:username/videos`

Admin routes require a loopback caller or
`Authorization: Bearer <IMPORT_API_TOKEN>`.

Rewind bridge:

- `GET /api/health`
- `GET /api/creators`
- `GET /api/videos?creatorId=&username=&fileId=&limit=` (legacy array response)
- `GET /api/videos?page=1&cursor=&creatorId=&username=&fileId=&limit=`
- `GET /api/videos?bookmarked=1&limit=5000`
- `GET /api/stats`
- Bookmark, import, trash, and restore routes proxied to the backend
- `GET|HEAD /media/:fileId`
- `GET|HEAD /media/:fileId?download=1`
- `GET|HEAD /thumbnail/:fileId.jpg`

## Configuration

`.env.example` documents every supported value. The main groups are:

| Area | Variables |
| --- | --- |
| Discord | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_OWNER_ID`, `WATCH_MANAGER_ROLE_ID`, `REGISTER_COMMANDS_ON_START` |
| Public URLs | `PUBLIC_BASE_URL`, `REWIND_PUBLIC_URL`, `CLOUDFLARE_TUNNEL_TOKEN` |
| Monitoring | `POLL_INTERVAL_SECONDS`, `PROFILE_SCAN_LIMIT`, `PROFILE_BURST_SCAN_LIMIT`, `MONITOR_CONCURRENCY` |
| Queue limits | `MAX_CONCURRENT_DOWNLOADS`, `MAX_DOWNLOAD_QUEUE_SIZE`, `MAX_QUEUED_DOWNLOADS_PER_USER`, `MAX_QUEUED_DOWNLOADS_PER_GUILD` |
| Imports | `IMPORT_API_TOKEN`, `IMPORT_MAX_DURATION_SECONDS`, `IMPORT_CONCURRENCY`, `IMPORT_PROFILE_TIMEOUT_SECONDS` |
| Retention | `DOWNLOAD_LINK_TTL_MINUTES`, `RETENTION_DAYS`, `ARCHIVE_TRASH_RETENTION_DAYS`, `CLEANUP_BATCH_SIZE`, `CLEANUP_ORPHAN_GRACE_MINUTES` |
| Media bounds | `DISCORD_UPLOAD_LIMIT_MB`, `MAX_MEDIA_DOWNLOAD_MB`, `MAX_SLIDESHOW_IMAGES`, `MAX_SLIDESHOW_ITEM_MB`, `MAX_SLIDESHOW_TOTAL_MB` |
| Paths/tools | `DATA_DIR`, `STATE_DB`, `DOWNLOAD_DIR`, `YTDLP_PATH`, `YTDLP_PROXY`, `YTDLP_COOKIES_FILE`, `YTDLP_RETRIES`, `YTDLP_TIMEOUT_SECONDS` |

If TikTok requires a logged-in session, export a **full** Netscape `tiktok.com`
cookie jar (not a hand-picked subset). The working live path needed
`sessionid`, `ttwid`, `msToken`, `odin_tt`, `sid_ucp_v1`, `uid_tt`, and the rest
of the jar — `sessionid` alone, or even `sessionid`+`ttwid`+`msToken`, was not
enough. Place the file at `./cookies/tiktok.txt` and set:

```env
YTDLP_COOKIES_FILE=/app/cookies/tiktok.txt
```

Then **rebuild and recreate** the bot container so it picks up `curl_cffi` and
`--impersonate chrome`:

```bash
docker compose up -d --build --force-recreate tiktok-discord-downloader
```

Compose already mounts `./cookies` read-only at `/app/cookies`. Never commit
cookies. yt-dlp `--cookies` rewrites its cookie file and can drop `sessionid`;
the bot copies the jar to a writable temp file for each yt-dlp run and leaves
the mounted original intact.

Export with a browser extension or follow the yt-dlp wiki Netscape format:
https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
The cookie account must already be able to play the post in a browser. Direct
video URLs work with that session. Listing a fully private account can still
fail in yt-dlp even when individual posts download; paste the post URL in that
case.

Unset `YTDLP_COOKIES_FILE` keeps the previous public-only behavior. A missing or
unreadable cookies file is a hard startup/download error, not a silent public
fallback. Content the cookie account cannot watch still fails with
`access_denied` / `auth_required` and is not retried.

`YTDLP_PROXY` is passed to yt-dlp as `--proxy` and is also set on the yt-dlp
child environment (`http_proxy` / `https_proxy`) so curl_cffi impersonation uses
the same proxy. Discord and the web service keep direct egress. Do not set
`HTTP_PROXY` on the bot container; that would proxy Discord too. This is useful
when TikTok blocks the host IP without forcing Discord or the web service through
the same proxy. A host-reachable proxy needs no Compose changes. If the proxy is
another container on an existing Docker network, enable the optional overlay:

```env
YTDLP_PROXY=http://gluetun:8888
COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml
YTDLP_PROXY_NETWORK=media_default
```

The base Compose file stays independent of that external network, so installs
that do not use a containerized proxy continue to start normally.

## Retention and storage behavior

- Manual/message downloads receive a temporary server copy by default.
- Buttons can create, extend, or permanently retain requester-owned links.
- Watched deliveries and creator imports are retained permanently by default.
- Shared assets remain until no active delivery references them.
- Dashboard deletion moves archive records to trash immediately. Trashed files
  stop appearing in Rewind and their download links stop working, but their
  bytes and delivery records remain restorable during the grace period.
- `ARCHIVE_TRASH_RETENTION_DAYS` controls permanent trash purging and defaults
  to 30 days. Set it to `0` to disable automatic purging.
- Cleanup deletes disk bytes before database records and preserves retry state
  when filesystem deletion fails.
- Inactive job/history metadata follows `RETENTION_DAYS`; file retention follows
  active links.
- Source-deletion checks run separately from profile polling so slow probes do
  not block creator monitoring.

## Local development and tests

Backend:

```bash
npm install
npm run dev
npm test
```

Direct backend operation expects `yt-dlp` and ffmpeg on `PATH` unless their
locations are overridden in `.env`.

Frontend with mock archive data:

```bash
cd web
npm install
npm run dev
npm run lint
npm test
```

Frontend against a remote live archive over SSH:

```bash
cd web
npm run dev:live
```

The live bridge defaults to the SSH host `yufeihl` and remote project
`/home/yufei/tiktok-discord-downloader`. Export `LIVE_SSH_HOST`,
`LIVE_REMOTE_PROJECT`, or `LIVE_BRIDGE_PORT` before the command to override
them. It copies requested media on demand, prefers saved JPEG thumbnail sidecars
before its ffmpeg fallback, and supports imports, trash, and restore operations
by forwarding them to the backend.

## Operational notes

- The monitor's normal profile window defaults to 5 posts and expands to a
  20-post burst scan when every normal result is new.
- Profile/story scans and downloads use separate bounded workers.
- Watched creator identity data caches TikTok `secUid` and author IDs when
  available.
- Saved-post deletion checks run frequently at first, then around 30 minutes,
  one hour, one day, and weekly.
- `DOWNLOAD_LINK_TTL_MINUTES` controls new temporary links. Legacy
  `DOWNLOAD_LINK_TTL_HOURS` values are ignored.
