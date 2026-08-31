# Project Work Log

This is the running engineering log for the multi-platform archive refactor. Keep it current as work lands so decisions, verification, and unfinished work survive across sessions.

## Goals

- Preserve the existing TikTok downloader, monitor, archive, Discord delivery, and Rewind behavior.
- Add Instagram and X/Twitter post saving, including images, videos, GIFs, carousels, and mixed-media posts.
- Represent posts with multiple ordered media assets instead of forcing every download into one video file.
- Support explicit links between profiles belonging to the same creator across platforms.
- Improve queue bounds, monitor delivery correctness, archive-read performance, security, recovery, CI, and deployment.
- Rename the project once the platform-neutral boundaries are in place and one new name can be applied consistently to packages, services, commands, docs, deployment, and UI.

## Decisions

- Platform identities remain distinct. A TikTok, Instagram, and X profile with the same handle are not assumed to be the same creator.
- Cross-platform relationships are explicit and reversible: platform profiles may belong to a shared creator group, and unlinking a profile must not remove its posts, watches, imports, or history.
- Post identity is `(platform, remote_post_id)`. Profile identity is `(platform, remote_profile_id)`, with a normalized handle used only as a lookup alias when a stable remote ID is unavailable.
- Existing rows will migrate as TikTok data.
- Direct post saving comes before Instagram/X profile imports and monitoring because individual-post extraction is the more stable platform surface.
- TikTok keeps its existing custom photo and story fallbacks. Instagram/X extraction will be isolated behind adapters with platform-specific cookie and proxy configuration.
- Extractor credentials must never be shared implicitly across platforms.

## Current Phase

The direct-save foundation, unified TikTok adapter path, versioned migrations,
durable monitor dead-letter flow, backend-owned Rewind reads, and operational
recovery/deployment gates landed on 2026-08-30. Rewind now has a separate
platform-neutral mixed-media library; authenticated Instagram/X smoke tests,
an immersive mixed-media feed decision, and the coordinated project rename remain.

## Completed

### 2026-08-30 — Exact Instagram Story saves

- Added strict `/stories/{username}/{story-id}` parsing for pasted Discord URLs and `/download`, stripping share tracking parameters and assigning a collision-safe `story_{id}` archive identity.
- Reused the isolated Instagram gallery-dl transport for one exact story, preserved the creator and original story media ID, and persisted `story` as the normalized media type for Discord and Rewind.
- Required the platform-scoped Instagram Netscape jar and its `sessionid` cookie before story extraction, while keeping ordinary public Instagram posts cookie-optional and never sharing TikTok/X credentials.
- Added adapter, Discord ingress, command-manifest, archive, and Store persistence coverage for the supplied story URL shape.

### 2026-08-30 — Baseline audit

- Verified all Compose services are running and healthy.
- Verified 123 backend tests pass.
- Verified 44 web unit/integration tests pass and web lint is clean.
- Confirmed the worktree was clean before implementation began.
- Identified that metadata extraction currently occurs outside the bounded download queue.
- Identified that a successful monitor delivery can mark a post globally seen before all subscribed Discord destinations succeed.
- Identified that Rewind filters archive rows by `.mp4`, walks `.info.json` files, and spawns a SQLite CLI process for archive queries.
- Identified that CI exercises only the backend and production deployment recreates only the backend service.

### 2026-08-30 — Platform URL and identity foundation

- Added an adapter registry for TikTok, Instagram, and X/Twitter with exact official-host matching, canonical URLs, and strict credential-free HTTPS validation.
- Added normalized platform-scoped post references so identical remote post IDs cannot collide across platforms.
- Added normalized profile references keyed by stable remote profile ID when available, with platform-qualified handles available as discovery aliases for explicit creator-group linking.
- Defined optional adapter operations for metadata probing, downloading, creator listing, and availability checks without changing the existing TikTok runtime path yet.
- Added URL extraction and canonicalization helpers for later Discord and download-service integration while leaving the existing TikTok utility API intact.

### 2026-08-30 — Durable monitor fan-out

- Added per-subscription, per-event alert delivery records with durable success, failure, attempt, and error state.
- New-post and deletion alert fan-out now skips destinations that already succeeded and retries only failed destinations.
- Discord sends no longer mark a post globally seen; the monitor does that only after every current destination succeeds.
- Separated alert failures from extractor failures so repeated Discord outages cannot poison a post and suppress later retries.

### 2026-08-30 — Platform-neutral Discord ingress

- Discord messages and `/download` now accept canonical TikTok, Instagram, and X post URLs through the platform registry.
- Message URL recognition rejects HTTP, credential-bearing, lookalike-host, profile, and unsupported-path URLs before download work starts.
- Existing TikTok `vm.`, `vt.`, and `/t/<token>` short-post links remain supported through the shared download-source resolver.
- Preserved the existing three-post message cap, sequential result delivery, and progress updates across mixed-platform messages.
- Updated manual-save, help, command, and status copy for supported media while keeping `/watch` explicitly TikTok-only.

### 2026-08-30 — Cross-platform creator persistence

- Added platform profiles with stable `(platform, remote_id)` identity and a unique per-platform current-handle fallback, so URL-discovered profiles can gain a stable remote ID without changing their database identity.
- Added explicit creator groups and reversible one-group-per-profile membership; linking profiles from different existing groups requires `mergeGroups: true`, and a merge preserves every existing member.
- Profile handle changes resolved by stable remote ID retain creator-group and media-post associations across restart. Duplicate handle-only placeholders reconcile into the stable profile without losing either group.
- Added platform-scoped jobs and files with TikTok defaults for existing rows; `(platform, post_id)` file lookup prevents identical TikTok, Instagram, and X IDs from colliding while the legacy video lookup remains TikTok-compatible.
- Wired normalized media-post and ordered-asset persistence through the Store for download and cleanup integration.

### 2026-08-30 — Explicit Discord profile linking

- Added `/profiles link`, `/profiles show`, and `/profiles unlink` with strict TikTok, Instagram, and X profile URLs.
- Linking is always an explicit authorized action; matching handles across platforms never create a relationship by themselves.
- A link command can merge both profiles' existing creator groups without losing other members only with `merge:true`, and an optional name applies to the merged group.
- Link and unlink are archive-wide bot-owner operations, while showing a group is read-only and available without mutation permission.
- Unlinking removes only creator-group membership and preserves the platform profile, saved media, and TikTok watch state.

### 2026-08-30 — Bounded download admission and extractor work

- Global download capacity now counts every admitted manual, import, and monitor request from before metadata resolution through final delivery persistence.
- Metadata probes share the configured download worker pool instead of starting outside concurrency limits.
- URL-identity and normalized post-identity single-flight behavior still coalesce duplicate probes and downloads, while every caller retains its own delivery record.
- Monitor work continues to bypass requester quotas but no longer bypasses global capacity, preventing an unbounded burst of extractor probes.

### 2026-08-30 — Production-safe Instagram and X extraction

- Added direct Instagram post/reel/carousel and X status multi-media adapters backed by gallery-dl 1.32.10.
- Probe output uses gallery-dl's JSON message protocol with numeric IDs preserved as strings, then normalizes one post and its ordered image, video, or animated assets.
- Downloads use an owned staging directory, fixed filenames, subprocess timeout and abort handling, bounded stdout/stderr, asset count, per-item bytes, total bytes, and strict regular-file/path validation.
- Each platform has independent cookie and proxy settings. Cookie jars are copied, reduced to matching platform domains, and removed after extraction; gallery-dl receives a minimal child environment that excludes application secrets and ambient proxies.
- The shared download service now archives multi-asset results, packages galleries, persists normalized post/asset metadata, and keeps TikTok on its existing extractor path.
- The built-in adapter-to-service integration is covered through the real archive and SQLite paths, including a cached second request that creates a new delivery without another extractor invocation.

### 2026-08-30 — TikTok monitor platform isolation

- Scoped legacy `seen_videos` archive joins, permanent-token lookup, and creator-video purge planning to TikTok files.
- Removing or purging an Instagram/X file can no longer clear a same-ID TikTok deletion schedule; TikTok file removal retains the existing reset behavior.
- Deletion workers now require an active permanent TikTok archive link, so a same-ID Instagram/X save cannot make a TikTok post eligible for availability checks.

### 2026-08-30 — Scoped monitor delivery reuse

- Permanent monitor deliveries are now reused by archived file and destination scope, so Discord retries and service restarts keep one stable link instead of creating another job and token on every failed send.
- Different Discord scopes still receive independent permanent links, while manual and expiring deliveries keep their existing one-delivery-per-request behavior.
- Historical duplicate permanent links remain valid; the lookup uses the latest matching delivery and prevents new duplicates without invalidating URLs already posted to Discord.

### 2026-08-30 — Legacy Rewind platform boundary

- Kept the current MP4-only Rewind interface explicitly TikTok-only across video, creator, bookmark, statistics, media, thumbnail, trash, restore, and permanent-delete paths.
- Same-handle Instagram/X files and pre-existing bookmark or trash rows remain invisible and cannot be mutated through the legacy Rewind APIs.
- Download and link-history Store reads now return `platform`, so platform-neutral callers retain identity even when remote post IDs and handles match.
- Left the scheduled retention cleanup platform-neutral; this boundary limits the legacy Rewind product surface without preventing lifecycle cleanup for future multi-platform trash workflows.

### 2026-08-30 — Discord attachment budget and manual fallback

- Multi-asset and slideshow delivery now enforces every configured per-file limit plus a 24 MiB whole-message attachment budget, leaving margin below Discord's 25 MiB request cap.
- Manual slash-command and pasted-URL sends retry as link-only when Discord returns 40005 or HTTP 413, preserving the saved public URL and retention buttons.
- Archive-wide download purge now requires the configured bot owner; guild managers remain limited to purging their own requester-scoped downloads.

### 2026-08-30 — Transactional media persistence and lifecycle safety

- File rows, normalized media posts, and ordered asset rows now commit in one SQLite transaction; identity guards reject cross-platform file/profile attachment before it can corrupt cleanup or cache reuse.
- A failed platform archive commit removes only adapter-owned bytes that are confirmed absent from SQLite, while an ambiguously committed path is preserved for safe retry.
- Persisted extractor metadata is a small explicit schema; large format arrays, headers, signed CDN URLs, and other transient yt-dlp transport data are not retained in SQLite.
- Expiry, monitor-delete, and purge flows claim files before disk I/O. Link creation/extension cannot revive a claimed file, and finalizers revalidate claim state and active links before cascading records.
- Deleting the last asset prunes its orphaned media post, while a post shared by another saved file keeps its metadata.

### 2026-08-30 — Cross-platform security and contract hardening

- Cached Instagram/X results prefer the stored extractor identity over a stale or misleading handle in a post URL; platform labels now disambiguate matching handles and post IDs in Discord lists/history.
- Instagram probe parsing matches gallery-dl's real `audio=false` behavior: the extractor's directory count may include skipped music, while selected visual URL messages remain independently bounded.
- Cookie-backed instances are documented as private/single-tenant because permitted Discord users share the configured account session.
- Added `cookies` to `.dockerignore` so TikTok, Instagram, and X session jars never enter local or remote Docker build contexts.
- Renamed the monitor action to `Delete saved copy` so it describes local archive deletion rather than implying source-post deletion.

### 2026-08-30 — Durable monitor dead letters and manual retry

- Replaced in-memory post poisoning with durable SQLite failure state. Repeated TikTok monitor extraction failures now become a dead letter without inserting a false `seen_videos` row.
- Automatic scans suppress dead-lettered posts while keeping the original source identity, failure count, last extractor error, and retry history available across restarts and username changes.
- Added `/watch failures` and `/watch retry post_id:<id>` for authorized watch managers, with per-server/DM subscription scoping so one destination cannot inspect or retry another destination's failures.
- Manual retries download the stored post directly even when it has fallen outside the profile scan window. Success resolves the dead letter and delivers current alerts; failure returns it to the retry list with the new error.
- Store startup recovers an interrupted in-flight manual retry back to `dead_letter`, and `/status` exposes the current unresolved count.

### 2026-08-30 — Versioned SQLite migrations

- Added an ordered `schema_migrations` ledger and synchronized SQLite `user_version`; the existing idempotent upgrade path is recorded as v1 and monitor dead letters as v2.
- Pending migrations run one at a time in `BEGIN IMMEDIATE` transactions, so failed DDL and its ledger row roll back together while earlier completed versions remain intact and retryable.
- Startup validates consecutive application versions against immutable recorded names and refuses migration gaps or a database newer than the running binary instead of silently applying an unknown schema.
- Existing pre-ledger databases still run the full legacy column, index, ownership, subscription, platform-profile, and media bootstrap before receiving their baseline record.
- `/status` now reports the active database schema version, and tests cover idempotency, rollback/retry, history drift, unsupported future versions, and asynchronous migration rejection.

### 2026-08-30 — TikTok adapter runtime unification

- Added TikTok adapter operations for metadata probes, direct downloads, creator listing, story listing, and post availability while retaining the existing yt-dlp, cookie-copy, follower-photo, story, slideshow, naming, and archive implementations.
- DownloadService now dispatches probes and downloads through adapter capabilities for every platform. Legacy TikTok test/deployment injectors remain compatibility overrides rather than a separate production branch.
- Creator imports use the TikTok adapter for profile discovery and duration probes, and the monitor uses it for normal/burst scans, stories, and deletion availability checks.
- Adapter capabilities now describe probe timing, owned staging archives, creator-handle precedence, and the legacy TikTok file identity fallback, replacing platform-name conditionals in the materialization path without changing saved results.
- Added parity tests for canonical URL/config propagation, adapter dispatch ordering, creator-import operations, profile rejection, and availability results.

### 2026-08-30 — Rewind cross-platform profile management

- Added authenticated backend endpoints to list explicit creator groups, link profile URLs or known profile IDs, rename groups, add profiles, and reversibly unlink members without touching saved media or watches.
- Rewind's live bridge exposes only the intended GET, POST, PATCH, and DELETE methods for those routes and forwards them through the existing private admin hop; it does not provide a generic backend proxy.
- Added a responsive creator-dashboard manager for TikTok, Instagram, and X profile URLs, including explicit merge confirmation, optional shared names, inline rename/add controls, direct source links, and reassignment of known unlinked profiles.
- Matching handles remain inert. Duplicate spellings of one profile cannot create a one-member group, and omitting a name while extending an existing group preserves its current name.
- Added backend, bridge, rendered-contract, and in-memory browser workflow coverage. Playwright execution remains unavailable on this host until its Chromium bundle is installed; the browser test itself is checked by lint and the production build.

### 2026-08-30 — Backend-owned Rewind archive reads

- Moved Rewind creator, video, bookmark-filter, exact-file, and statistics SQL into Store methods on the backend's long-lived SQLite connection; the bridge no longer spawns a `sqlite3` process for each archive request.
- Added authenticated `/api/rewind/*` backend contracts with bounded limits and validated keyset cursor fields, while preserving the browser-facing response shapes, legacy creator IDs, metadata sidecar enrichment, row caches, and TikTok-only visibility boundary.
- Added partial active-TikTok indexes as schema migration v3 for global and per-username Rewind ordering. Existing databases apply the indexes atomically through the migration ledger.
- Removed the SQLite CLI and `LIVE_DB_PATH` from the Rewind image/runtime. Rewind still mounts media read-only for byte-range delivery and thumbnail generation, but the backend is now the sole database owner.
- Added Store, HTTP, query-contract, and live-bridge integration coverage, including proof that IDs returned in a page serve from the row cache without a second backend lookup.

### 2026-08-30 — Platform-neutral Rewind media library

- Added schema migration v4 with active-media ordering indexes and a backend-owned Rewind post query that filters by platform, profile, creator group, exact file, bookmark state, and stable keyset cursor.
- The authenticated `/api/rewind/posts` contract returns normalized creator/group identity and ordered content assets while retaining package metadata for delivery; legacy rows receive a safe synthetic primary asset.
- Added browser-facing `/api/posts`, `/post-media/:fileId/:assetIndex`, and `/post-download/:fileId` routes. The bridge strips filesystem paths, uses bounded row caches, constrains content types, supports byte ranges, forces package downloads, and keeps media access inside the archive root.
- Added a responsive Media dashboard for TikTok, Instagram, and X images, videos, animations, galleries, archives, and mixed posts, including platform/search filters, ordered-asset navigation, source links, and package downloads.
- Added dedicated platform-neutral post bookmark mutations, optimistic card controls, and a bookmark-only Media filter. Instagram/X bookmarks persist in the shared file-keyed table while the legacy `/api/bookmarks` list remains TikTok/MP4-only.
- Added confirmed platform-neutral trash and restore mutations plus Active/Trash Media views. Restoration verifies the package and every recorded asset still exist, trash preserves bookmarks, and trashed asset/package routes remain unavailable until restoration.
- Kept permanent deletion out of the new Media UI. The existing retention worker already claims and purges trashed files across platforms with shared-path protection, while legacy immediate-delete routes remain TikTok-only.
- Hardened lifecycle failure and race handling: incomplete galleries stay in trash, a concurrent cleanup claim returns a retryable conflict, failed browser mutations keep their confirmation and current row intact, and successful responses must confirm both the action and file ID.
- Verified scheduled retention against a real Instagram package with ordered assets, including bookmark/link/database cascades and preservation of a shared asset still referenced by an active X post.
- Bounded bridge row-cache freshness to 30 seconds so an out-of-band trash or purge cannot leave media indefinitely eligible for serving; mutations made through Rewind still invalidate every relevant cache immediately.
- Updated the production same-origin gateway for the new asset routes and added Store, HTTP, bridge integration, rendered-contract, gateway, and strict in-memory browser coverage. Playwright execution still requires the browser bundle that CI installs.

### 2026-08-30 — Operational recovery and full-stack delivery gates

- Added dependency-aware backend readiness backed by a live SQLite probe and schema version; Rewind readiness now fails when either the backend or read-only archive mount is unavailable.
- Restricted browser CORS responses to the configured Rewind origin and exact loopback development origins, while keeping Cloudflare Access as the actual authentication boundary.
- Added WAL-aware online SQLite snapshots with source/copy integrity checks, SHA-256 sidecars, restrictive permissions, and bounded retention. A tested restore command verifies the selected snapshot, preserves the replaced database first, and requires explicit stopped-service confirmation.
- Production deployment now targets the exact commit that passed CI, refuses stale rollback, builds backend and Rewind while the old stack is online, backs up before migrations, recreates both services together, and waits for both health checks without restarting `cloudflared`.
- CI now gates deployment on backend tests/contracts, Rewind lint/unit/integration/build checks, desktop and mobile Chromium workflows, Compose validation, and both production image builds. Browser execution remains unavailable on this host because its Playwright Chromium bundle is not installed, but CI installs it explicitly.

## Verification Log

| Date | Check | Result |
| --- | --- | --- |
| 2026-08-30 | `npm test` | 123 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `docker compose ps` | Backend, Rewind, and cloudflared healthy/running |
| 2026-08-30 | `node --test test/index-alert.test.js test/monitor.test.js test/discord-ui.test.js test/config-files-store.test.js` | 74 passed |
| 2026-08-30 | `node --test test/platforms.test.js` | 6 passed |
| 2026-08-30 | `node --test test/discord-ingress.test.js test/commands.test.js test/discord-ui.test.js test/config-files-store.test.js test/platforms.test.js` | 62 passed |
| 2026-08-30 | `npm test` | 141 passed |
| 2026-08-30 | `node --test test/creator-profiles-store.test.js test/config-files-store.test.js` | 43 passed |
| 2026-08-30 | `node --test test/commands.test.js test/discord-profiles.test.js test/discord-ingress.test.js test/config-files-store.test.js` | 49 passed |
| 2026-08-30 | `npm test` | 157 passed |
| 2026-08-30 | `node --test test/gallery-dl.test.js test/platforms.test.js` | 10 passed |
| 2026-08-30 | `npm test` | 158 passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `docker compose build tiktok-discord-downloader` | Passed; gallery-dl 1.32.10 installed and version-checked |
| 2026-08-30 | `npm test` | 161 passed |
| 2026-08-30 | `node --test test/gallery-dl.test.js test/platforms.test.js test/download-service.test.js` | 18 passed |
| 2026-08-30 | `npm test` | 162 passed |
| 2026-08-30 | `node --test test/download-service.test.js test/index-alert.test.js test/config-files-store.test.js` | 51 passed |
| 2026-08-30 | `npm test` | 164 passed |
| 2026-08-30 | `node --test test/http-server.test.js test/config-files-store.test.js` | 48 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `npm test` | 169 passed |
| 2026-08-30 | `node --test test/discord-ui.test.js test/discord-ingress.test.js test/config-files-store.test.js` | 63 passed |
| 2026-08-30 | `node --test test/discord-ui.test.js test/discord-ingress.test.js test/config-files-store.test.js test/discord-profiles.test.js` | 68 passed |
| 2026-08-30 | `node --test test/config-files-store.test.js test/platform-monitor-store-isolation.test.js` | 48 passed |
| 2026-08-30 | `npm test` | 179 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/platforms.test.js test/download-service.test.js test/creator-import.test.js test/index-alert.test.js` | 32 passed |
| 2026-08-30 | `npm test` | 190 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/migrations.test.js test/monitor-failures-store.test.js test/config-files-store.test.js` | 51 passed |
| 2026-08-30 | `npm test` | 187 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npm run build` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `node --test test/commands.test.js test/discord-monitor-failures.test.js test/monitor.test.js test/monitor-failures-store.test.js` | 28 passed |
| 2026-08-30 | `npm test` | 184 passed |
| 2026-08-30 | `cd web && node --test tests/*.test.mjs` | 44 passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `find src test -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | `npm test` | 203 passed |
| 2026-08-30 | `cd web && npm test` | Production build passed; 51 tests passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `find src test scripts -name '*.js' -print0 | xargs -0 -n1 node --check` | Passed |
| 2026-08-30 | `node --check web/scripts/live-bridge.mjs web/scripts/live-bridge-core.mjs web/scripts/start-live.mjs web/scripts/start-live-core.mjs` | Passed |
| 2026-08-30 | `docker compose config --quiet` | Passed |
| 2026-08-30 | `bash -n scripts/deploy-prod.sh` | Passed |
| 2026-08-30 | Parse `.github/workflows/*.yml` with PyYAML | Passed |
| 2026-08-30 | `git diff --check` | Passed |
| 2026-08-30 | Focused Playwright mixed-media workflow | Build/server passed; browser launch unavailable because the local Chromium bundle is not installed |
| 2026-08-30 | `npm test` | 204 passed |
| 2026-08-30 | `cd web && npm test` | Production build passed; 54 tests passed |
| 2026-08-30 | `cd web && npm run lint` | Passed |
| 2026-08-30 | `cd web && npx playwright test --list` | 96 desktop/mobile tests discovered; TypeScript test loading passed |
| 2026-08-30 | `find src test scripts -name '*.js' ... node --check` plus bridge/gateway `.mjs` checks | Passed |
| 2026-08-30 | `docker compose config --quiet` and `docker compose ps` | Passed; backend and Rewind healthy, cloudflared running |
| 2026-08-30 | Deploy shell syntax, workflow YAML parse, and `git diff --check` | Passed |
| 2026-08-30 | `npm test` after exact Instagram Story support | 206 passed |

## Rename Follow-up

The current repository, package, service, commands, deployment checks, and documentation are TikTok-named. Do not rename only one layer. Choose the new name, then change all of these together with compatibility notes for operators and existing Discord commands.

Candidate direction: keep **Rewind** as the product name and use a descriptive repository/package name such as `rewind-media-archive`. Final naming remains undecided.

## Next Work

- Run authenticated Instagram/X smoke tests in the private production environment without exposing session material.
- Decide whether mixed-media posts belong in the immersive feed and whether Media needs an explicitly confirmed immediate permanent-delete action in addition to automatic retention cleanup.
- Choose the final project name, then rename repository, package, service, deployment, Discord, and UI surfaces together.
