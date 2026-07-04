# TikTok Discord Downloader

Discord bot that monitors public TikTok usernames, downloads new videos with
`yt-dlp`, and delivers them through Discord as either an uploaded attachment or
an expiring download link.

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
DOWNLOAD_LINK_TTL_HOURS=360
```

Do not commit `.env`; it is ignored by git.

## Discord Commands

The bot watches every guild channel it can read plus DMs. When someone posts a
TikTok URL, it downloads the video and replies in that channel or DM. Global
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
- `/history`
- `/downloads list limit:<1-25>` shows your active download links plus
  monitored downloads.
- `/downloads purge scope:mine|all confirm:PURGE` deletes saved download files,
  public links, and download history. `scope:all` requires Manage Server.

The bot requires the `Guilds`, `Guild Messages`, `Direct Messages`, and
`Message Content` intents. Enable Message Content in the Discord developer
portal for the application.

Watched usernames only alert for videos newer than when the watch was added.
Videos with no timestamp metadata are treated as eligible so new uploads are not
missed when TikTok or `yt-dlp` omits dates.

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
  `DISCORD_UPLOAD_LIMIT_MB`; larger videos are linked.
- Every download gets a 15-day link by default. Discord buttons let you create
  another 15-day link, extend the current link by 15 days, or keep it
  permanently.
