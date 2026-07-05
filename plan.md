# Discord UI and Download-Link Behavior Plan

This plan is for a larger Discord UI/UX pass plus revised download-link
retention semantics. It is intended for another coding agent to implement in
small, testable phases.

## Goals

- Make bot replies consistently embed-based where appropriate.
- Make `/downloads list` a polished, paginated, button-driven embed UI.
- Add optional username filtering to `/downloads list`.
- Ensure `/downloads list` only shows permanent saved downloads.
- Deduplicate `/downloads list` so only one row appears per downloaded file/post.
- Change default generated links to expire after 30 minutes unless the user
  clicks `Keep on server`.
- Keep permanent downloads indefinitely until explicitly purged.
- Add or improve history so users can see a history of generated links,
  titles, usernames, expiry/permanent state, and related details.
- Keep behavior incremental, tested, and easy to review.

## Current UI Surface Inventory

Primary UI code is in `src/discord/client.js`.

Important functions:

- `startDiscordBot`
  - Routes `interactionCreate` and `messageCreate`.
  - Button routing currently covers link buttons and downloads-list pagination.
  - Error fallback should become a consistent error embed.

- `handleInteraction`
  - Routes slash commands.
  - `/download` uses `buildDeliveryPayload`.
  - `/watch add/remove/list/run` mostly uses notice embeds.
  - `/status` uses `buildStatusEmbed`.
  - `/history` currently shows recent jobs, not link history.
  - `/downloads` delegates to `handleDownloadsInteraction`.

- `handleMessageCreate`
  - Handles message-based TikTok URL downloads.
  - Still has some plain status/error strings.

- `buildDeliveryPayload`
  - Builds successful download responses.
  - Handles attachment vs link delivery and link-management buttons.

- `handleLinkButton`
  - Handles `link:new:<token>`, `link:extend:<token>`,
    `link:permanent:<token>`.
  - These should align with the new 30-minute default link behavior.

- `handleDownloadsInteraction`
  - Handles `/downloads list` and `/downloads purge`.
  - `/downloads list` should become permanent-downloads-only.

- `buildDownloadsListPayload`, `buildDownloadsListEmbed`,
  `buildDownloadsPaginationRows`
  - Existing list UI should be refined and adjusted for permanent-only,
    deduplicated results.

State/storage code is in `src/state/store.js`.

Important methods:

- `createFileRecord`
- `createLinkToken`
- `getToken`
- `getValidToken`
- `extendLinkToken`
- `setLinkTokenPermanent`
- `listDownloadLinksByRequester`
- `countDownloadLinksByRequester`
- `purgeDownloads`
- `listJobs`

Tests are mainly in:

- `test/config-files-store.test.js`
- `test/commands.test.js`
- `test/http-server.test.js`
- `test/ytdlp.test.js`

Consider adding a dedicated `test/discord-ui.test.js` once UI helpers are
extracted.

## New Product Semantics

### Default Link Lifetime

Default generated links should expire after 30 minutes, not 15 days.

Implementation options:

- Preferred: add a config setting such as `DOWNLOAD_LINK_TTL_MINUTES` with
  default `30`, while preserving backward compatibility for
  `DOWNLOAD_LINK_TTL_HOURS` only if already set.
- Simpler: change `downloadLinkTtlHours` default to `0.5` is not compatible
  with current `parsePositiveInt`, so avoid this unless config parsing changes.
- Best practical approach: introduce `downloadLinkTtlMinutes` in
  `src/config.js`, default `30`, and use it for generated non-permanent links.

Generated links affected:

- Initial link created by `/download`.
- Initial link created by message-based URL download.
- Initial link created by monitored alert download.
- New link created by `link:new:<token>`.
- Reused cached downloads that generate a fresh link.

Permanent behavior:

- `link:permanent:<token>` should set `expires_at = 0`.
- A file with at least one permanent link must not be deleted by expiry cleanup.
- `/downloads list` should show only files/links that are permanent.

### Downloads List

`/downloads list` should show saved permanent downloads only.

Rules:

- Exclude 30-minute temporary links from `/downloads list`.
- Show at most one item per downloaded file/post, even if there are duplicate
  permanent links.
- Prefer deduping by `files.id`.
- If there can be multiple file records for the same TikTok post, consider
  deduping by `video_id` only if the product decision is "one post row". Start
  with `files.id` dedupe because file records map directly to disk files.
- Include username, title/caption, size, source URL if useful, permanent link,
  created/saved date, and post id where available.
- Keep optional `username` filtering.
- Keep pagination and user-scoped buttons.
- Empty state should say there are no permanent downloads, and mention using
  `Keep on server` to save one.

Store query changes:

- Add a dedicated method, for example:
  - `listPermanentDownloadsByRequester(requestedBy, options)`
  - `countPermanentDownloadsByRequester(requestedBy, options)`
- These should filter `link_tokens.expires_at = 0`.
- Deduplicate so each file appears once.
- Choose a stable permanent token for each file, probably the newest permanent
  token or earliest permanent token. Use one link in the UI.
- Preserve `includeMonitored`, `username`, `limit`, and `offset` behavior.

### History

History should show a history of generated links, not only jobs.

Desired `/history` content:

- Link creation timestamp.
- TikTok username.
- Title/caption, trimmed.
- Source URL or post id.
- Link URL.
- Expiry state:
  - `expires <timestamp>` for temporary links.
  - `permanent` for kept links.
  - `expired` for expired links if history includes expired rows.
- File size.
- Job/download status if available.
- Whether the file was reused from cache if stored/available.

Implementation options:

- Minimum viable: add `store.listLinkHistoryByRequester(requestedBy, options)`
  querying `link_tokens JOIN files`, optionally left joining latest job title.
- Better: include all links for the requester plus monitored downloads visible
  to them, mirroring current list semantics.
- Decide whether `/history` should be global recent jobs or user-specific link
  history. Recommended: for normal users, show their link history plus monitored
  downloads; for admins, a later option can expose global history.

Potential command schema:

- Keep `/history` as-is initially, but change output to link history.
- Optional later enhancement: `/history limit:<1-25> username:<username>`.
- Any schema change requires `npm run register:commands`.

## Design Principles

- Use embeds as the default response shape.
- Plain `content` should be reserved for pings, file attachments, and direct
  compatibility fallbacks.
- Use consistent colors:
  - Info/TikTok accent: neutral status and lists.
  - Success: completed action or permanent save.
  - Warning: temporary link, expiring state, partial success.
  - Error: failures, missing permissions, invalid/expired tokens.
- Keep text concise and scannable.
- Trim aggressively:
  - Embed title max 256, but prefer 120-180.
  - Field name max 256, prefer under 120.
  - Field value max 1024.
  - Embed description max 4096, prefer much shorter.
  - Total embed text below 6000.
- Preserve intentional visibility:
  - Slash command management replies are ephemeral.
  - Message URL downloads reply publicly in the channel.
  - Watch alerts are public.
  - Link-management button replies are ephemeral.

## Phased Implementation Plan

### Phase 1: Config and Link TTL

Files:

- `src/config.js`
- `src/index.js`
- `src/discord/client.js`
- `test/config-files-store.test.js`

Tasks:

- Add `downloadLinkTtlMinutes` config with default `30`.
- Update link creation to use minutes:
  - initial downloads
  - reused cached downloads
  - `link:new`
- Rename user-facing copy from "15-day link" to "30-minute link" where
  applicable.
- Keep `link:extend` behavior under review:
  - Option A: extend by 30 minutes.
  - Option B: remove extend and rely on "create new 30-minute link".
  - Recommended: change `Extend 15d` to `Extend 30m` for now.

Tests:

- Config default is 30 minutes.
- Created tokens expire at about now + 30 minutes.
- `link:new` creates a 30-minute token.
- `link:extend` extends by 30 minutes if retained.

### Phase 2: Permanent Downloads Store Queries

Files:

- `src/state/store.js`
- `test/config-files-store.test.js`

Tasks:

- Add `listPermanentDownloadsByRequester`.
- Add `countPermanentDownloadsByRequester`.
- Filter `link_tokens.expires_at = 0`.
- Deduplicate by file id.
- Return one stable token per file.
- Support:
  - `requestedBy`
  - `includeMonitored`
  - `username`
  - `limit`
  - `offset`
- Ensure expired temporary links do not appear.

Tests:

- Temporary-only file is excluded from permanent downloads list.
- File with one permanent and several temporary links appears once.
- Username filter is case-insensitive.
- Pagination offset works.
- Monitored downloads still appear when `includeMonitored: true`.

### Phase 3: `/downloads list` UI Semantics

Files:

- `src/discord/client.js`
- `test/config-files-store.test.js` or new `test/discord-ui.test.js`
- `README.md`

Tasks:

- Switch `/downloads list` to use permanent-download store methods.
- Update embed title/copy:
  - `Saved Downloads`
  - `Saved Downloads for @username`
- Empty state: no permanent downloads saved.
- Each item should include:
  - username
  - trimmed title/caption
  - permanent link
  - size
  - saved date or token creation date
  - post id if available
- Keep Prev/Next buttons.
- Ensure custom ids stay under 100 chars.

Tests:

- List excludes temporary links.
- Duplicate permanent links produce one UI row.
- Long captions are trimmed.
- Username appears in each item.
- Pagination buttons are correctly disabled.
- Other-user button click returns an error embed.

### Phase 4: Link History

Files:

- `src/state/store.js`
- `src/discord/client.js`
- optionally `src/discord/commands.js`
- tests

Tasks:

- Add a link-history store method, for example:
  - `listLinkHistoryByRequester(requestedBy, options)`
  - `countLinkHistoryByRequester(requestedBy, options)` if paginated.
- Query `link_tokens JOIN files`.
- Include expired, active temporary, and permanent links unless product decides
  otherwise.
- Add title via latest related job if possible.
- Render `/history` as an embed showing link history:
  - username
  - title
  - link
  - expiry/permanent/expired state
  - size
  - created timestamp
- Consider adding pagination later if history can exceed 10 items.

Tests:

- History includes temporary and permanent links.
- History includes expired links if retained in DB.
- History trims long titles/errors.
- History includes username and expiry state.
- History remains under embed limits.

### Phase 5: Extract UI Helpers

Files:

- New `src/discord/ui.js`
- `src/discord/client.js`
- new `test/discord-ui.test.js`

Tasks:

- Move reusable UI helpers out of `client.js`:
  - colors
  - `truncateText`
  - `formatBytes`
  - `formatExpiry`
  - notice/error/progress payload builders
  - common embed field helpers
- Keep behavior unchanged while extracting.

Tests:

- Truncation and whitespace normalization.
- Notice/error payload shape.
- Embed limit safety.

### Phase 6: Normalize Remaining Replies

Files:

- `src/discord/client.js`
- `src/discord/ui.js`
- tests

Tasks:

- Replace remaining plain command error text with embeds.
- Convert message-based URL progress and failure responses to embeds.
- Convert help response into an embed.
- Polish successful download embed fields:
  - creator
  - size
  - media type
  - delivery state
  - temporary/permanent server copy state
- Keep attachments working exactly as before.
- Ensure reused cached downloads in `auto` still send links, not attachments.

Tests:

- Help payload is embed-based.
- Message download failure is embed-based.
- Successful small upload still includes attachment.
- Reused cached download does not attach in auto mode.
- Large `delivery:file` returns warning embed.

## Risks and Edge Cases

- Discord `custom_id` max is 100 chars.
- Discord embeds allow max 25 fields and total 6000 characters.
- Interaction lifecycle matters:
  - deferred commands need `editReply`
  - button pagination uses `update`
  - link mutation buttons use ephemeral `reply`
- Temporary 30-minute links may expire before users open `/history`.
- Existing DB rows may have 15-day expiry from older code. Do not attempt a
  destructive migration unless explicitly requested.
- Cleanup deletes files only when no active/permanent links remain. This must
  still hold after TTL changes.
- Permanent list should not accidentally show stale file records whose files
  are missing.
- If `PUBLIC_BASE_URL` is missing, embeds need a clear warning instead of a
  broken blank link.
- Captions can contain long text, newlines, URLs, or unusual whitespace.
- TikTok metadata can omit username/title/id/thumbnail.

## Acceptance Criteria

- New generated links expire after 30 minutes by default.
- `Keep on server` makes a file permanent by setting the token expiry to `0`.
- `/downloads list` shows only permanent saved downloads.
- `/downloads list` deduplicates duplicate permanent links for the same file.
- `/downloads list` supports username filtering, includes username in each row,
  trims long titles/captions, and paginates with scoped buttons.
- `/history` shows link history with title, username, link, expiry state, size,
  and created time.
- Command and button replies are consistently embed-based where appropriate.
- Existing attachment behavior is preserved.
- Reused cached downloads do not redownload and do not auto-attach unless
  explicitly requested with `delivery:file`.
- Tests cover TTL, permanent-only listing, dedupe, history, pagination,
  trimming, and core UI payloads.
- `npm test` passes.
- If slash command schemas change, run `npm run register:commands` during
  deployment.
