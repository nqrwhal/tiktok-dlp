import { test, expect } from "./fixtures/archive";
import { currentFeedCardId, revealFeedControls } from "./helpers";

const BOOKMARK_STORAGE_KEY = "rewind-bookmarks";
const MIGRATION_STORAGE_KEY = "rewind-bookmarks-server-migrated-v1";

test("migrates legacy bookmarks sequentially in bounded batches only once", async ({ page, archive }) => {
  const legacyIds = ["1001", "1002", ...Array.from({ length: 1_099 }, (_, index) => String(10_000 + index))];
  await page.addInitScript(({ storageKey, migrationKey, ids }) => {
    if (sessionStorage.getItem("rewind-e2e-bookmarks-seeded") === "1") return;
    sessionStorage.setItem("rewind-e2e-bookmarks-seeded", "1");
    localStorage.setItem(storageKey, JSON.stringify(ids));
    localStorage.removeItem(migrationKey);
  }, { storageKey: BOOKMARK_STORAGE_KEY, migrationKey: MIGRATION_STORAGE_KEY, ids: legacyIds });

  await page.goto("/?video=1001");
  await expect.poll(() => archive.requestLog({ method: "POST", pathname: "/api/bookmarks" }).length).toBe(3);

  const migrations = archive.requestLog({ method: "POST", pathname: "/api/bookmarks" });
  expect(migrations.map((request) => (request.body as { fileIds: unknown[] }).fileIds.length)).toEqual([500, 500, 101]);
  expect([...archive.bookmarks].sort()).toEqual(["1001", "1002"]);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), MIGRATION_STORAGE_KEY)).toBe("1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Saved video feed" })).toBeVisible();
  expect(archive.requestLog({ method: "POST", pathname: "/api/bookmarks" })).toHaveLength(3);
});

test("unbookmarking during legacy migration flushes a delete after the POST", async ({ page, archive }) => {
  await page.addInitScript(({ storageKey, migrationKey }) => {
    localStorage.setItem(storageKey, JSON.stringify(["1001"]));
    localStorage.removeItem(migrationKey);
  }, { storageKey: BOOKMARK_STORAGE_KEY, migrationKey: MIGRATION_STORAGE_KEY });
  const migration = archive.delayNextRequest((request, url) => (
    request.method() === "POST" && url.pathname === "/api/bookmarks"
  ));

  await page.goto("/?video=1001");
  await migration.waitUntilRequested();
  await revealFeedControls(page);
  await page.getByRole("button", { name: /^Remove bookmark / }).click();
  migration.release();

  await expect.poll(() => archive.requestLog({ pathname: "/api/bookmarks/1001" }).map((entry) => entry.method)).toEqual(["DELETE"]);
  await expect(page.getByRole("button", { name: /^Bookmark / })).toHaveAttribute("aria-pressed", "false");
  expect(archive.bookmarks.has("1001")).toBe(false);
});

test("serializes rapid toggles and leaves the server at the latest intent", async ({ page, archive }) => {
  await page.goto("/?video=1001");
  await revealFeedControls(page);
  const fileId = await currentFeedCardId(page);
  expect(fileId).toBe("1001");
  const gate = archive.delayNextBookmarkMutation({ fileId: "1001", method: "PUT" });

  await page.getByRole("button", { name: /^Bookmark / }).click();
  await gate.waitUntilRequested();
  await page.getByRole("button", { name: /^Remove bookmark / }).click();
  await page.waitForTimeout(100);
  expect(archive.requestLog({ pathname: "/api/bookmarks/1001" })).toHaveLength(1);

  gate.release();
  await expect.poll(() => archive.requestLog({ pathname: "/api/bookmarks/1001" }).map((entry) => entry.method)).toEqual(["PUT", "DELETE"]);
  await expect(page.getByRole("button", { name: /^Bookmark / })).toHaveAttribute("aria-pressed", "false");
  expect(archive.bookmarks.has("1001")).toBe(false);
});

test("another open tab refreshes only after a bookmark mutation reaches the server", async ({ page, context, archive }) => {
  const otherPage = await context.newPage();
  await Promise.all([
    page.goto("/?video=1001"),
    otherPage.goto("/?video=1001"),
  ]);
  await revealFeedControls(page);
  await revealFeedControls(otherPage);
  const gate = archive.delayNextBookmarkMutation({ fileId: "1001", method: "PUT" });

  await page.getByRole("button", { name: /^Bookmark / }).click();
  await gate.waitUntilRequested();
  await expect(otherPage.getByRole("button", { name: /^Bookmark / })).toHaveAttribute("aria-pressed", "false");
  gate.release();

  await expect(otherPage.getByRole("button", { name: /^Remove bookmark / })).toHaveAttribute("aria-pressed", "true");
});

test("removing a bookmark keeps the adjacent card active and restores control focus", async ({ page, archive }) => {
  archive.seedBookmarks(["1001", "1002", "1003", "1004"]);
  await page.goto("/?video=1001");
  await revealFeedControls(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  const activeCard = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(activeCard).toHaveCount(1);

  const firstActive = await activeCard.getAttribute("data-video-id");
  await page.locator("#feed-stage").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => activeCard.getAttribute("data-video-id")).not.toBe(firstActive);
  await revealFeedControls(page);
  const orderedIds = await page.locator("[data-feed-card]").evaluateAll((cards) => (
    cards.map((card) => (card as HTMLElement).dataset.videoId || "")
  ));
  const currentId = await currentFeedCardId(page);
  const currentIndex = orderedIds.indexOf(currentId || "");
  const expectedAdjacentId = orderedIds[currentIndex + 1] || orderedIds[currentIndex - 1];

  await page.getByRole("button", { name: /^Remove bookmark / }).click();

  await expect(page.locator('[data-feed-card][aria-hidden="false"]')).toHaveAttribute("data-video-id", expectedAdjacentId);
  await expect(page.locator("[data-bookmark-control]:focus")).toHaveAttribute("aria-pressed", "true");
  expect(archive.bookmarks.has(currentId || "")).toBe(false);
});

test("retries transient failures, rolls back, and lets the user retry", async ({ page, archive }) => {
  archive.failNextBookmarkMutations(4, 503, "Temporary bookmark outage");
  await page.goto("/?video=1001");
  await revealFeedControls(page);
  await page.getByRole("button", { name: /^Bookmark / }).click();

  await expect.poll(() => archive.requestLog({ pathname: "/api/bookmarks/1001" }).length, { timeout: 8_000 }).toBe(4);
  await expect(page.getByRole("button", { name: /^Bookmark / })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(/Temporary bookmark outage|bookmark update failed/i)).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();

  await expect.poll(() => archive.bookmarks.has("1001")).toBe(true);
  await expect(page.getByRole("button", { name: /^Remove bookmark / })).toHaveAttribute("aria-pressed", "true");
});

test("loads creator-scoped bookmark pages without leaking another creator", async ({ page, archive }) => {
  archive.seedBookmarks(archive.videos.map((video) => video.id));
  await page.goto("/?creator=creator-alice&video=1001");
  await revealFeedControls(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();

  await expect.poll(() => archive.requestLog({ method: "GET", pathname: "/api/videos", includes: "bookmarked=1" }).length).toBeGreaterThan(0);
  const firstPage = archive.requestLog({ method: "GET", pathname: "/api/videos", includes: "bookmarked=1" }).at(-1);
  const firstPageParams = new URLSearchParams(firstPage?.search);
  expect(firstPageParams.get("creatorId")).toBe("creator-alice");
  expect(firstPageParams.get("limit")).toBe("36");
  await expect(page.getByRole("button", { name: "Load more bookmarks" })).toBeVisible();
  await page.locator("#feed-video-list").evaluate((scroller) => scroller.scrollTo(0, scroller.scrollHeight));
  const activeCard = page.locator('[data-feed-card][aria-hidden="false"]');
  await expect(activeCard).toHaveCount(1);
  const activeBeforeLoad = await activeCard.getAttribute("data-video-id");
  await page.getByRole("button", { name: "Load more bookmarks" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => archive.requestLog({ method: "GET", pathname: "/api/videos", includes: "bookmarked=1" }).some((entry) => new URLSearchParams(entry.search).has("cursor"))).toBe(true);
  await expect(activeCard).toHaveAttribute("data-video-id", activeBeforeLoad || "");

  await page.goto("/?creator=creator-bob");
  await revealFeedControls(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect.poll(() => archive.requestLog({ method: "GET", pathname: "/api/videos", includes: "bookmarked=1" }).some((entry) => new URLSearchParams(entry.search).get("creatorId") === "creator-bob")).toBe(true);
  await expect(page.getByRole("button", { name: /Show controls for Bob Builds/ })).toBeVisible();
});

test("a trashed bookmark is hidden, preserved, and returns after restore", async ({ page, context, archive }) => {
  archive.seedBookmarks(["1001"]);
  archive.seedTrash(["1001"]);
  await page.goto("/?video=1002");
  await revealFeedControls(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No bookmarks" })).toBeVisible();
  expect(archive.bookmarks.has("1001")).toBe(true);

  const dashboard = await context.newPage();
  await dashboard.goto("/dashboard/videos");
  await dashboard.getByRole("tab", { name: "Trash" }).click();
  await dashboard.getByRole("button", { name: "Restore", exact: true }).first().click();
  await dashboard.getByRole("dialog", { name: "Restore this video?" })
    .getByRole("button", { name: "Restore video" })
    .click();
  await expect(dashboard.getByRole("status")).toContainText("Restored");

  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: /Show controls for Alice Archive archive clip 001/ })).toBeVisible();
  expect(archive.bookmarks.has("1001")).toBe(true);
});
