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

Fill in `.env` with your Discord bot token, application/client ID,
notification channel ID, and `PUBLIC_BASE_URL`.

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
  downloads plus monitored downloads that were kept on the server.
- `/downloads purge scope:mine|all confirm:PURGE` deletes saved download files,
  public links, and download history. `scope:all` requires Manage Server.

The bot requires the `Guilds`, `Guild Messages`, `Direct Messages`, and
`Message Content` intents. Enable Message Content in the Discord developer
portal for the application.

Watched usernames alert for videos newer than when the watch was added and also
try to detect public stories. Stories are downloaded when detected, even when
TikTok or `yt-dlp` omits timestamp metadata.
The default monitor interval is 60 seconds; set `POLL_INTERVAL_SECONDS` to a
positive integer to tune it. Successful checks are scheduled per account so a
slow full scan does not add another full interval before the next check.
`MONITOR_CONCURRENCY` controls concurrent profile/story checks and defaults to
2. Downloads are queued separately and capped by `MAX_CONCURRENT_DOWNLOADS`.
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

Then run the app and tunnel together:

```bash
docker compose --profile cloudflare up --build -d
```

The tunnel token is copied into `.secrets/cloudflare_tunnel_token` locally and
mounted read-only into the `cloudflared` container.

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
  the bot reuses that file and creates a fresh link instead of downloading it
  again. Fresh metadata is still used for the Discord embed.
- Manual and message-based downloads get a temporary 30-minute server copy by
  default. When every link for a file expires, the local file and file record
  are removed. Discord buttons let you create another temporary link, extend the
  current link by the configured TTL, or keep the file permanently on the
  server.
- Watched-user downloads are kept permanently on the server by default.
- Watched-user files are stored under `DOWNLOAD_DIR/<username>/...`.
- Watched-user identity data caches TikTok `secUid` and author id when they are
  available. Later checks use `secUid` for faster `yt-dlp` profile polling and
  author id for story checks, reducing redundant profile-page requests.
- After a watched post is saved, the bot checks whether the original post still
  exists every minute for five minutes, then around 30 minutes, one hour, one
  day, and weekly after that. If the source post disappears, Discord gets a
  deletion notice with the saved-copy link when available.
- `DOWNLOAD_LINK_TTL_MINUTES` controls new temporary links. Legacy
  `DOWNLOAD_LINK_TTL_HOURS` values are ignored.
