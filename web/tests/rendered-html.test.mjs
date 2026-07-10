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
    }
    if (pathname === "/dashboard" || pathname === "/dashboard/videos") {
      assert.match(html, /href="\/\?creator=[^"&]+(?:&amp;|&)video=v-/i);
    }
    if (pathname === "/dashboard/videos") assert.doesNotMatch(html, /Export selected/i);
    if (pathname === "/dashboard/settings") {
      assert.match(html, /Autoplay videos/i);
      assert.doesNotMatch(html, /Poll interval|frontend preview/i);
    }
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  });
}

test("feed exposes confirmed server trash and bounded delivery", async () => {
  const source = await readFile(new URL("../components/feed/MobileFeed.tsx", import.meta.url), "utf8");
  assert.match(source, /Move to trash/i);
  assert.match(source, /method:\s*"DELETE"/);
  assert.match(source, /confirmFileId:\s*deleteVideo\.id/);
  assert.match(source, /const CARD_WINDOW_SIZE = 7/);
  assert.match(source, /paginateVideos:\s*true/);
  assert.match(source, /renderedVideos\.map/);
  assert.match(source, /const PRELOAD_AHEAD = 1/);
  assert.match(source, /Tap for controls · swipe to browse/);
  assert.match(source, /type="range"/);
  assert.match(source, /aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight M B"/);
  assert.match(source, /shouldIgnoreFeedShortcut/);
});

test("video dashboard exposes trash listing and confirmed restore", async () => {
  const librarySource = await readFile(new URL("../components/dashboard/VideoLibrary.tsx", import.meta.url), "utf8");
  const source = await readFile(new URL("../components/dashboard/TrashLibrary.tsx", import.meta.url), "utf8");
  assert.match(librarySource, /id="video-library-trash-tab"/);
  assert.match(librarySource, /<TrashLibrary apiBase=\{apiBase\} onRestored=\{handleRestoredVideo\}/);
  assert.match(librarySource, /archive\.refresh\(\)/);
  assert.match(source, /\/api\/trash\?limit=1000/);
  assert.match(source, /\/api\/videos\/\$\{restoreVideo\.fileId\}\/restore/);
  assert.match(source, /method:\s*"POST"/);
  assert.match(source, /confirmFileId:\s*restoreVideo\.fileId/);
  assert.match(source, /Restore this video\?/);
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
  assert.match(types, /cancelRequestedAt: number \| null/);
  assert.match(types, /retryCount: number/);
  assert.match(types, /resumeCount: number/);
});

test("failed feed pages use a retry backoff instead of an immediate render loop", async () => {
  const source = await readFile(new URL("../lib/useArchiveData.ts", import.meta.url), "utf8");
  assert.match(source, /const VIDEO_PAGE_RETRY_DELAY_MS = 10_000/);
  assert.match(source, /Date\.now\(\) < loadMoreRetryAfterRef\.current/);
  assert.match(source, /loadMoreRetryAfterRef\.current = Date\.now\(\) \+ VIDEO_PAGE_RETRY_DELAY_MS/);
});
