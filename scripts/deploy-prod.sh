#!/usr/bin/env bash
# Idempotent production deploy for the Discord bot on yufeihl.
# Does not print cookie values, tokens, or .env contents.
set -euo pipefail

ROOT="${ROOT:-/home/yufei/tiktok-discord-downloader}"
SERVICE="tiktok-discord-downloader"
LIVE_COOKIES="data/tiktok-cookies.txt"
MASTER_COOKIES="data/tiktok-cookies.master.txt"
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-90}"
LOGIN_WAIT_SECONDS="${LOGIN_WAIT_SECONDS:-30}"

export GIT_TERMINAL_PROMPT=0
# Never enable the cloudflare profile; cloudflared must not be recreated.
export COMPOSE_PROFILES=""

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'deploy-prod: %s\n' "$*" >&2
  exit 1
}

has_sessionid_cookie_name() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  # Netscape rows are tab-separated; cookie name is field 6. Never print values.
  awk '
    BEGIN { found = 0 }
    {
      sub(/\r$/, "")
      line = $0
      if (line ~ /^#HttpOnly_/) sub(/^#HttpOnly_/, "", line)
      else if (line ~ /^#/) next
      if (line ~ /^[[:space:]]*$/) next
      n = split(line, fields, "\t")
      if (n < 6) n = split(line, fields, /[[:space:]]+/)
      if (n >= 6 && fields[6] == "sessionid") { found = 1; exit }
    }
    END { exit found ? 0 : 1 }
  ' "$file"
}

require_clean_tracked_tree() {
  local dirty
  dirty="$(git status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    printf 'deploy-prod: refusing to deploy; tracked working tree has unexpected changes:\n' >&2
    git status --untracked-files=no >&2
    exit 1
  fi
}

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

container_id() {
  compose ps -q "$SERVICE"
}

container_field() {
  local cid="$1"
  local format="$2"
  docker inspect -f "$format" "$cid"
}

wait_for_health() {
  local cid=""
  local status=""
  local running=""
  local elapsed=0
  while (( elapsed <= HEALTH_WAIT_SECONDS )); do
    cid="$(container_id)"
    [[ -n "$cid" ]] || die "service ${SERVICE} is not running"
    running="$(container_field "$cid" '{{.State.Running}}')"
    [[ "$running" == "true" ]] || die "container is not running (health/status: ${status:-unknown})"
    status="$(container_field "$cid" '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
    if [[ "$status" == "healthy" ]]; then
      log "Container health: healthy (${elapsed}s)"
      return 0
    fi
    if [[ "$status" == "running" ]]; then
      # Image without a healthcheck: State.Status is running; Dockerfile healthcheck uses healthy.
      log "Container has no healthcheck; status is running (${elapsed}s)"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  die "container was not healthy within ${HEALTH_WAIT_SECONDS}s (last status: ${status:-unknown})"
}

logs_show_discord_login() {
  compose logs --no-color --tail 200 "$SERVICE" 2>/dev/null \
    | grep -E -q '\[discord\] Logged in as goforthetiktok'
}

wait_for_discord_login() {
  local elapsed=0
  while (( elapsed <= LOGIN_WAIT_SECONDS )); do
    if logs_show_discord_login; then
      log "Discord login confirmed for goforthetiktok"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  printf 'deploy-prod: recent %s logs did not show Discord login for goforthetiktok\n' "$SERVICE" >&2
  compose logs --no-color --tail 80 "$SERVICE" \
    | awk 'BEGIN { IGNORECASE = 1 }
      /discord_token|authorization:|bearer |sessionid[\t=]/ { next }
      { print }
    ' >&2
  exit 1
}

assert_not_crash_looping() {
  local cid="$1"
  local running restarts oom
  running="$(container_field "$cid" '{{.State.Running}}')"
  restarts="$(container_field "$cid" '{{.RestartCount}}')"
  oom="$(container_field "$cid" '{{.State.OOMKilled}}')"
  [[ "$running" == "true" ]] || die "container is not running"
  [[ "$oom" == "false" ]] || die "container was OOM-killed"
  if [[ "$restarts" != "0" ]]; then
    die "container restart count is ${restarts}; treating as a crash loop"
  fi
}

[[ -d "$ROOT" ]] || die "production root does not exist: ${ROOT}"
cd "$ROOT"

[[ -d .git ]] || die "production root is not a git checkout: ${ROOT}"
[[ -f docker-compose.yml ]] || die "docker-compose.yml missing in ${ROOT}"
command -v git >/dev/null || die "git is not on PATH"
command -v docker >/dev/null || die "docker is not on PATH"
docker compose version >/dev/null || die "docker compose is not available"

COMPOSE_FILES=(-f docker-compose.yml)
if [[ -f docker-compose.proxy.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.proxy.yml)
fi

require_clean_tracked_tree

log "Fetching origin and fast-forwarding main"
git fetch origin
git checkout main
require_clean_tracked_tree
git pull --ff-only origin main
require_clean_tracked_tree

HEAD_SHA="$(git rev-parse HEAD)"
log "HEAD ${HEAD_SHA}"

if [[ -f "$MASTER_COOKIES" ]]; then
  if [[ ! -f "$LIVE_COOKIES" ]] || ! has_sessionid_cookie_name "$LIVE_COOKIES"; then
    log "Restoring live cookie jar from master (sessionid cookie name missing or live file absent)"
    mkdir -p data
    cp -a "$MASTER_COOKIES" "$LIVE_COOKIES"
    chmod 600 "$LIVE_COOKIES"
  else
    log "Live cookie jar already has a sessionid cookie name; leaving it in place"
  fi
else
  log "No master cookie jar at ${MASTER_COOKIES}; skipping cookie restore"
fi

log "Rebuilding and recreating ${SERVICE}"
compose up -d --build --force-recreate "$SERVICE"

wait_for_health
cid="$(container_id)"
[[ -n "$cid" ]] || die "could not resolve container id for ${SERVICE}"
assert_not_crash_looping "$cid"
wait_for_discord_login
assert_not_crash_looping "$cid"

IMAGE_ID="$(container_field "$cid" '{{.Image}}')"
STATUS="$(container_field "$cid" '{{.State.Status}}')"
HEALTH="$(container_field "$cid" '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}')"

log "Deploy OK"
log "HEAD=${HEAD_SHA}"
log "container=${cid}"
log "status=${STATUS}"
log "health=${HEALTH}"
log "image=${IMAGE_ID}"
compose ps "$SERVICE"
