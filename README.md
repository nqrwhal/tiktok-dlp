# TikTok Discord Downloader

Discord bot that monitors public TikTok usernames, downloads new videos with
`yt-dlp`, and delivers them through Discord as either an uploaded attachment or
an expiring download link.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your Discord bot token, application/client ID, guild ID,
notification channel ID, and `PUBLIC_BASE_URL`.

Do not commit `.env`; it is ignored by git.

## Discord Commands

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

The bot uses only the `Guilds` intent. It does not require Message Content
Intent because all interaction is slash-command based.

## Docker

```bash
docker compose up --build -d
docker compose logs -f
```

Persistent state and downloads live in `./data`.

If TikTok starts requiring authenticated cookies for your use case, place a
cookies file under `./cookies/tiktok.txt` and set:

```env
YTDLP_COOKIES_FILE=/app/cookies/tiktok.txt
```

## Health

```bash
curl http://localhost:8080/health
```

## Notes

- Public TikTok content only. This tool does not bypass private accounts,
  deleted videos, paywalls, or access controls.
- Download links require `PUBLIC_BASE_URL` to be reachable by the Discord users
  who click them.
- Small videos are uploaded to Discord when they fit under
  `DISCORD_UPLOAD_LIMIT_MB`; larger videos are linked.
