import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

const routes = [
  ["/", /Show controls for/i],
  ["/?video=v-1041", /Show controls for/i],
  ["/?creator=mina-makes&video=v-1042", /Show controls for/i],
  ["/creator?creator=mina-makes", /Open feed/i],
  ["/dashboard", /Open feed/i],
  ["/dashboard/videos", /Search videos/i],
  ["/dashboard/media", /Search saved media/i],
  ["/dashboard/creators", /Import creator/i],
  ["/dashboard/settings", /Save changes/i],
];

for (const [pathname, expectedContent] of routes) {
  test(`server-renders ${pathname}`, async () => {
    const response = await render(pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(html, /<title>[^<]*Rewind<\/title>/i);
    assert.match(html, expectedContent);
    if (pathname === "/") {
      assert.match(html, />Bookmarks<\/button>/i);
      assert.equal(html.match(/preload="auto"/gi)?.length, 1);
    }
    if (pathname.startsWith("/creator")) {
      assert.match(html, /href="\/\?creator=mina-makes(?:&amp;|&)video=v-1042"/i);
      assert.match(html, /id="creator-video-grid"/i);
      assert.match(html, /role="status">(?:All \d+ saved videos are loaded|No more videos are available to load\. Showing \d+ of \d+ saved videos\.)<\/p>/i);
      assert.doesNotMatch(html, />All videos loaded<\/button>/i);
    }
    if (pathname === "/dashboard" || pathname === "/dashboard/videos") {
      assert.match(html, /href="\/\?creator=[^"&]+(?:&amp;|&)video=v-/i);
    }
    if (pathname === "/dashboard/videos") {
      assert.doesNotMatch(html, /Export selected/i);
      assert.match(html, /aria-controls="video-library-active-panel"/i);
      assert.match(html, />All videos loaded<\/button>/i);
      assert.match(html, /role="status">\d+ of \d+ videos loaded<\/span>/i);
    }
    if (pathname === "/dashboard/settings") {
      assert.match(html, /Autoplay videos/i);
      assert.doesNotMatch(html, /Poll interval|frontend preview/i);
    }
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  });
}

test("feed exposes confirmed server trash and bounded delivery", async () => {
  const source = await readFile(new URL("../components/feed/MobileFeed.tsx", import.meta.url), "utf8");
  const bookmarkSource = await readFile(new URL("../lib/bookmark-state.mjs", import.meta.url), "utf8");
  assert.match(source, /Move to trash/i);
  assert.match(source, /method:\s*"DELETE"/);
  assert.match(source, /confirmFileId:\s*deleteVideo\.id/);
  assert.match(source, /const CARD_WINDOW_SIZE = 7/);
  assert.match(source, /paginateVideos:\s*true/);
  assert.match(source, /renderedVideos\.map/);
  assert.match(source, /const PRELOAD_AHEAD = 2/);
  assert.match(source, /const PLAYABLE_READY_STATE = 2/);
  assert.match(source, /onLoadedData=/);
  assert.match(source, /useBookmarks/);
  assert.match(bookmarkSource, /\/api\/bookmarks/);
  assert.match(bookmarkSource, /BOOKMARK_MIGRATION_STORAGE_KEY/);
  assert.match(source, /Tap for controls · swipe to browse/);
  assert.match(source, /type="range"/);
  assert.match(source, /aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight M B"/);
  assert.match(source, /shouldIgnoreFeedShortcut/);
});

test("video dashboard exposes size sorting, trash listing, confirmed restore, and permanent delete", async () => {
  const librarySource = await readFile(new URL("../components/dashboard/VideoLibrary.tsx", import.meta.url), "utf8");
  const source = await readFile(new URL("../components/dashboard/TrashLibrary.tsx", import.meta.url), "utf8");
  assert.match(librarySource, /id="video-library-trash-tab"/);
  assert.match(librarySource, /<TrashLibrary[\s\S]*?onRestored=\{handleRestoredVideo\}[\s\S]*?onDeleted=\{handlePermanentlyDeletedVideo\}/);
  assert.match(librarySource, /archive\.refresh\(\)/);
  assert.match(librarySource, /Sort videos by size, largest first/);
  assert.match(librarySource, /left\.video\.sizeBytes - right\.video\.sizeBytes/);
  assert.match(librarySource, /onDeletedAll=\{handlePermanentlyDeletedAll\}/);
  assert.match(source, /\/api\/trash\?limit=1000/);
  assert.match(source, /confirmDeleteAll:\s*true/);
  assert.match(source, /Permanently delete all trash\?/);
  assert.match(source, /\/api\/trash\/\$\{deleteVideo\.fileId\}/);
  assert.match(source, /\/api\/videos\/\$\{restoreVideo\.fileId\}\/restore/);
  assert.match(source, /method:\s*"POST"/);
  assert.match(source, /confirmFileId:\s*restoreVideo\.fileId/);
  assert.match(source, /Restore this video\?/);
  assert.match(source, /Permanently delete this video\?/);
});

test("creator imports remain durable and actionable outside the open panel", async () => {
  const source = await readFile(new URL("../components/dashboard/CreatorManager.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
  assert.match(source, /void loadImports\(\)\.catch/);
  assert.match(source, /if \(!hasActiveImport\) return/);
  assert.doesNotMatch(source, /if \(!importOpen \|\| !hasActiveImport\) return/);
  assert.match(source, /\/api\/imports\/\$\{entry\.id\}\/\$\{action\}/);
  assert.match(source, /runImportAction\(entry, "cancel"\)/);
  assert.match(source, /runImportAction\(entry, "retry"\)/);
  assert.match(source, /const IMPORT_FAILURE_DETAIL_LIMIT = 5/);
  assert.match(source, /\.filter\(\(item\) => item\.status === "failed"\)/);
  assert.match(source, /\.slice\(0, IMPORT_FAILURE_DETAIL_LIMIT\)/);
  assert.match(source, /skippedUnknownDurationCount/);
  assert.match(types, /"completed" \| "failed" \| "canceled"/);
  assert.match(types, /"canceling"/);
  assert.match(types, /cancelRequestedAt: number \| null/);
  assert.match(types, /retryCount: number/);
  assert.match(types, /resumeCount: number/);
});

test("creator dashboard can stop monitoring without deleting its archive", async () => {
  const source = await readFile(new URL("../components/dashboard/CreatorManager.tsx", import.meta.url), "utf8");
  assert.match(source, /Turn off monitoring/);
  assert.match(source, /\/api\/creators\/\$\{encodeURIComponent\(monitorCreator\.username\)\}\/monitoring/);
  assert.match(source, /method:\s*"DELETE"/);
  assert.match(source, /Saved videos were kept/);
  assert.match(source, /every configured destination/);
});

test("creator dashboard manages explicit and reversible cross-platform profile links", async () => {
  const manager = await readFile(new URL("../components/dashboard/CreatorManager.tsx", import.meta.url), "utf8");
  const source = await readFile(new URL("../components/dashboard/ProfileGroupManager.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
  assert.match(manager, /<ProfileGroupManager apiBase=\{apiBase\}/);
  assert.match(source, /\/api\/profile-groups/);
  assert.match(source, /matching handles never link automatically/i);
  assert.match(source, /mergeGroups/);
  assert.match(source, /method: "POST" \| "PATCH" \| "DELETE"/);
  assert.match(source, /\/profiles\/\$\{profile\.id\}/);
  assert.match(source, /aria-label=\{`Unlink/);
  assert.match(types, /export interface CreatorProfileGroup/);
  assert.match(types, /export interface PlatformProfile/);
});

test("media dashboard preserves platform identity and ordered post assets", async () => {
  const source = await readFile(new URL("../components/dashboard/MediaLibrary.tsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../lib/useArchivePosts.ts", import.meta.url), "utf8");
  const types = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
  assert.match(source, /post\.assets\[activeIndex\]/);
  assert.match(source, /moveAsset\(post, 1\)/);
  assert.match(source, /All platforms/);
  assert.match(source, /post\.downloadUrl/);
  assert.match(source, /archive\.setBookmarked\(post, !post\.bookmarked\)/);
  assert.match(source, /aria-pressed=\{post\.bookmarked\}/);
  assert.match(source, /Move this post to trash\?/);
  assert.match(source, /Restore this post\?/);
  assert.match(source, /archive\.moveToTrash\(lifecycleAction\.post\)/);
  assert.match(source, /archive\.restore\(lifecycleAction\.post\)/);
  assert.match(source, /hasMediaFilters \? "No matching trash" : "Trash is empty"/);
  assert.match(hook, /\/api\/posts\?/);
  assert.match(hook, /\/api\/post-bookmarks\//);
  assert.match(hook, /\/api\/media-posts\//);
  assert.match(hook, /payload\.restoredPost === true/);
  assert.match(hook, /payload\.trashedPost === true/);
  assert.match(hook, /params\.set\("platform", platform\)/);
  assert.match(hook, /params\.set\("bookmarked", "1"\)/);
  assert.match(hook, /params\.set\("trashed", "1"\)/);
  assert.match(hook, /byId\.set\(post\.id, post\)/);
  assert.match(types, /export interface SavedMediaAsset/);
  assert.match(types, /export interface SavedPost/);
});

test("failed feed pages use a retry backoff instead of an immediate render loop", async () => {
  const source = await readFile(new URL("../lib/useArchiveData.ts", import.meta.url), "utf8");
  assert.match(source, /const VIDEO_PAGE_RETRY_DELAY_MS = 10_000/);
  assert.match(source, /Date\.now\(\) < loadMoreRetryAfterRef\.current/);
  assert.match(source, /loadMoreRetryAfterRef\.current = Date\.now\(\) \+ VIDEO_PAGE_RETRY_DELAY_MS/);
});
