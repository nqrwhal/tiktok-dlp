# TikTok Discord Downloader

Discord bot that monitors public TikTok usernames, downloads new videos with
`yt-dlp`, falls back to ZIP packaging for public photo/slideshow posts, and
delivers them through Discord as either an uploaded attachment or an expiring
download link.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your Discord bot token, application/client ID, and
`PUBLIC_BASE_URL`. `DISCORD_CHANNEL_ID` is only a fallback for legacy watches;
new watches use the channel where an authorized manager creates them.

Example public download URL configuration:

```env
PUBLIC_BASE_URL=https://example.com
DOWNLOAD_LINK_TTL_MINUTES=30
```

Do not commit `.env`; it is ignored by git.

## Discord Commands

The bot watches every guild channel it can read plus DMs. When someone posts a
TikTok URL, it downloads the post and replies in that channel or DM. Global
slash commands work in guild channels and bot DMs for explicit actions and
management.

For message-based help, use `tiktok help` or `!tiktok help` in a guild channel,
mention the bot with `help`, or DM the bot `help`.

Register slash commands:

```bash
npm run register:commands
```

Commands:

- `/download url:<tiktok-url> delivery:auto|file|link`
- `/watch add username:<username>`
- `/watch remove username:<username>`
- `/watch list`
- `/watch run username:<username>`
- `/status`
- `/history` shows your recent generated download links and their expiry state.
- `/downloads list limit:<1-25> username:<username>` shows your saved permanent
  downloads plus monitored downloads delivered to the current server or DM.
- `/downloads purge scope:mine|all confirm:PURGE` deletes saved download files,
  public links, and download history. `scope:all` requires Manage Server.

The bot requires the `Guilds`, `Guild Messages`, `Direct Messages`, and
`Message Content` intents. Enable Message Content in the Discord developer
portal for the application.

Watch commands are administrative: in a guild they require Manage Server or
`WATCH_MANAGER_ROLE_ID`; in a DM they require `DISCORD_OWNER_ID`. Watches are
subscribed per guild/DM, so the same creator can alert independently in more
than one server without duplicate profile scans. `/watch run` only accepts a
watch already registered in the current scope.

Watched usernames alert for videos newer than when the watch was added and also
try to detect public stories. Stories are downloaded when detected, even when
TikTok or `yt-dlp` omits timestamp metadata.
The default monitor interval is 60 seconds; set `POLL_INTERVAL_SECONDS` to a
positive integer to tune it. Successful checks are scheduled per account so a
slow full scan does not add another full interval before the next check.
`MONITOR_CONCURRENCY` controls concurrent profile/story checks and defaults to
2. Manual, message, and monitor downloads share a bounded queue capped by
`MAX_CONCURRENT_DOWNLOADS`. The queue deduplicates in-flight posts by canonical
post ID and applies per-user and per-guild limits for interactive requests.
`PROFILE_SCAN_LIMIT` defaults to 5 and caps the normal recent-profile window
`yt-dlp` enumerates for each check. If all entries in that window are new alert
candidates, the monitor immediately performs a deeper catch-up scan up to
`PROFILE_BURST_SCAN_LIMIT`, which defaults to 20.
The `/status` command shows monitor cycle timing, queued/active downloads,
worker counts, and recent scan totals.
When profile metadata reports that a watched creator now has a different
username, the bot updates the watch record and posts a username-change notice.
This depends on TikTok or `yt-dlp` still resolving the old profile URL far
enough to expose the creator identity.

## Creator profile imports

The backend can queue a full public-profile import through `POST /api/imports`:

```json
{
  "username": "creator",
  "maxDurationSeconds": 120
}
```

It enumerates the complete profile, skips files already present on disk, skips
videos longer than the requested limit, and downloads the remaining posts as
permanent archive files. `IMPORT_MAX_DURATION_SECONDS` sets the default to 120
seconds; callers can override it from 1 to 3600 seconds. Full-profile discovery
uses `IMPORT_PROFILE_TIMEOUT_SECONDS` (600 by default), and
`IMPORT_CONCURRENCY` controls concurrent profile jobs.

Use `GET /api/imports` or `GET /api/imports/:id` to read progress. Import routes
accept loopback requests, which is how the local dashboard bridge calls them.
Non-loopback callers must send `Authorization: Bearer <IMPORT_API_TOKEN>`.

## Docker

```bash
docker compose up --build -d
docker compose logs -f
```

Persistent state and downloads live in `./data`.
When using the Cloudflare profile, the app's HTTP server is exposed only inside
the Docker network; public traffic comes through Cloudflare Tunnel.

## Cloudflare Tunnel

Create a Cloudflare Tunnel public hostname:

```text
example.com -> http://tiktok-discord-downloader:8080
```

Put the tunnel token in `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=...
```

Prepare the Docker secret on the host, then run the app and tunnel together:

```bash
npm run prepare:tunnel
docker compose --profile cloudflare up --build -d
```

`prepare:tunnel` writes `.secrets/cloudflare_tunnel_token` locally and the
Compose file mounts it only into the `cloudflared` container. The downloader
container does not receive the tunnel token.

If TikTok starts requiring authenticated cookies for your use case, place a
cookies file under `./cookies/tiktok.txt` and set:

```env
YTDLP_COOKIES_FILE=/app/cookies/tiktok.txt
```

## Health

```bash
curl https://example.com/health
```

## Notes

- Public TikTok content only. This tool does not bypass private accounts,
  deleted videos, paywalls, or access controls.
- Download links require `PUBLIC_BASE_URL` to be reachable by the Discord users
  who click them.
- Small videos are uploaded to Discord when they fit under
  `DISCORD_UPLOAD_LIMIT_MB`; larger videos and slideshow ZIPs are linked.
- If a TikTok post was already downloaded and the file still exists locally,
  the bot reuses one immutable asset and creates a fresh, requester-owned link
  instead of downloading it again. Fresh metadata is still used for the Discord
  embed.
- Manual and message-based downloads get a temporary 30-minute server copy by
  default. When every link for a file expires, the local file and file record
  are removed. Discord buttons let you create another temporary link, extend the
  current link by the configured TTL, or keep that link permanently on the
  server. Only its requester, a server manager, or the configured bot owner can
  change a link's retention.
- Watched-user deliveries are kept permanently on the server by default, but a
  monitor delivery never changes the expiry of another requester's link to the
  same asset.
- Profile imports use the same download queue and immutable asset store as
  manual and monitored downloads. Imported files receive permanent archive
  links so cleanup does not remove them after the job completes.
- `/downloads purge scope:mine` removes only the caller's deliveries. A shared
  asset remains until no active delivery references it. Disk bytes are removed
  before their database record, and failed removals keep a persisted retry
  state rather than losing the asset record.
- `RETENTION_DAYS` retains inactive job/history metadata; file retention is
  governed by active links. Slideshow and direct HTTP fallback downloads enforce
  configured size, item-count, and timeout limits and stream ZIP output to disk.
- Watched-user files are stored under `DOWNLOAD_DIR/<username>/...`.
- Watched-user identity data caches TikTok `secUid` and author id when they are
  available. Later checks use `secUid` for faster `yt-dlp` profile polling and
  author id for story checks, reducing redundant profile-page requests.
- After a watched post is saved, the bot checks whether the original post still
  exists every minute for five minutes, then around 30 minutes, one hour, one
  day, and weekly after that. These checks run in a separate bounded worker so
  slow availability probes do not block profile polling. If the source post
  disappears, Discord gets a deletion notice with the saved-copy link when
  available.
- `DOWNLOAD_LINK_TTL_MINUTES` controls new temporary links. Legacy
  `DOWNLOAD_LINK_TTL_HOURS` values are ignored.
