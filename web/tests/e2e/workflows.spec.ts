import { test, expect } from "./fixtures/archive";

test("media dashboard filters platforms, advances mixed posts, and downloads their package", async ({ page, archive }) => {
  await page.goto("/dashboard/media");

  const mixedCard = page.getByRole("article").filter({ hasText: "Moss launch carousel" });
  await expect(mixedCard).toBeVisible();
  await expect(mixedCard).toContainText("Instagram");
  await expect(mixedCard).toContainText("Mixed media");
  await expect(mixedCard.getByRole("img", { name: "Moss launch carousel" })).toBeVisible();
  await expect(mixedCard.getByText("1 / 2")).toBeVisible();

  await mixedCard.getByRole("button", { name: "Next asset in Moss launch carousel" }).click();
  await expect(mixedCard.getByLabel("Moss launch carousel, asset 2")).toBeVisible();
  await expect(mixedCard.getByText("2 / 2")).toBeVisible();

  await mixedCard.getByRole("button", { name: "Bookmark Moss launch carousel" }).click();
  await expect(mixedCard.getByRole("button", { name: "Remove bookmark for Moss launch carousel" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(archive.posts.find((post) => post.id === "2001")?.bookmarked).toBe(true);
  expect(archive.requestLog({ method: "PUT", pathname: "/api/post-bookmarks/2001" })).toHaveLength(1);

  await page.getByRole("button", { name: "Bookmarked", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(archive.requestLog({ method: "GET", pathname: "/api/posts", includes: "bookmarked=1" })).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove bookmark for Moss launch carousel" }))
    .toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Platform").selectOption("instagram");
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByText("Interface motion study")).toHaveCount(0);
  expect(archive.requestLog({ method: "GET", pathname: "/api/posts", includes: "platform=instagram" })).toHaveLength(1);

  await page.getByPlaceholder("Search saved media").fill("launch film");
  await expect(page.getByRole("status").filter({ hasText: "1 loaded post" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download", exact: true }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("instagram-studio.moss-2001.zip");
  expect(archive.requestLog({ method: "GET", pathname: "/post-download/2001" })).toHaveLength(1);

  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  const trashDialog = page.getByRole("dialog", { name: "Move this post to trash?" });
  await expect(trashDialog).toContainText("bookmark is preserved");
  await trashDialog.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved Moss launch carousel to trash" })).toBeVisible();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("trashed");
  expect(await page.evaluate(async () => Promise.all([
    fetch("/post-media/2001/0").then((response) => response.status),
    fetch("/post-download/2001").then((response) => response.status),
  ]))).toEqual([404, 404]);

  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trashedCard = page.getByRole("article").filter({ hasText: "Moss launch carousel" });
  await expect(trashedCard).toBeVisible();
  await trashedCard.getByRole("button", { name: "Restore", exact: true }).click();
  const restoreDialog = page.getByRole("dialog", { name: "Restore this post?" });
  await restoreDialog.getByRole("button", { name: "Restore post", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Restored Moss launch carousel" })).toBeVisible();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("active");
  expect(archive.requestLog({ method: "DELETE", pathname: "/api/media-posts/2001" })).toHaveLength(1);
  expect(archive.requestLog({ method: "POST", pathname: "/api/media-posts/2001/restore" })).toHaveLength(1);
});

test("media lifecycle failures keep the confirmation open and retry without losing state", async ({ page, archive }) => {
  archive.failNextRequests(
    (request, url) => request.method() === "DELETE" && url.pathname === "/api/media-posts/2001",
    1,
    503,
    "Archive lifecycle unavailable",
  );
  await page.goto("/dashboard/media");
  const activeCard = page.getByRole("article").filter({ hasText: "Moss launch carousel" });
  await activeCard.getByRole("button", { name: "Move to trash", exact: true }).click();
  const trashDialog = page.getByRole("dialog", { name: "Move this post to trash?" });
  await trashDialog.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(trashDialog.getByRole("alert")).toHaveText("Archive lifecycle unavailable");
  await expect(activeCard).toBeVisible();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("active");

  await trashDialog.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(trashDialog).toBeHidden();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("trashed");

  archive.failNextRequests(
    (request, url) => request.method() === "POST" && url.pathname === "/api/media-posts/2001/restore",
    1,
    409,
    "Archived media is incomplete",
  );
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trashedCard = page.getByRole("article").filter({ hasText: "Moss launch carousel" });
  await trashedCard.getByRole("button", { name: "Restore", exact: true }).click();
  const restoreDialog = page.getByRole("dialog", { name: "Restore this post?" });
  await restoreDialog.getByRole("button", { name: "Restore post", exact: true }).click();
  await expect(restoreDialog.getByRole("alert")).toHaveText("Archived media is incomplete");
  await expect(trashedCard).toBeVisible();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("trashed");

  await restoreDialog.getByRole("button", { name: "Restore post", exact: true }).click();
  await expect(restoreDialog).toBeHidden();
  expect(archive.posts.find((post) => post.id === "2001")?.retentionStatus).toBe("active");
  expect(archive.requestLog({ method: "DELETE", pathname: "/api/media-posts/2001" })).toHaveLength(2);
  expect(archive.requestLog({ method: "POST", pathname: "/api/media-posts/2001/restore" })).toHaveLength(2);
});

test("video trash and restore preserve its bookmark", async ({ page, archive }) => {
  archive.seedBookmarks(["1001"]);
  await page.goto("/dashboard/videos");
  const actions = page.getByRole("button", { name: /More actions for Alice Archive archive clip 001/ });
  await actions.click();
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  const trashDialog = page.getByRole("dialog", { name: "Move this video to trash?" });
  await trashDialog.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved" })).toBeVisible();
  expect(archive.trash.has("1001")).toBe(true);
  expect(archive.bookmarks.has("1001")).toBe(true);

  await page.getByRole("tab", { name: "Trash" }).click();
  const restore = page.getByRole("button", { name: "Restore", exact: true }).first();
  await restore.click();
  await page.getByRole("dialog", { name: "Restore this video?" }).getByRole("button", { name: "Restore video" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Restored" })).toBeVisible();
  expect(archive.trash.has("1001")).toBe(false);
  expect(archive.bookmarks.has("1001")).toBe(true);
});

test("video size header sorts both directions and trash deletes one video permanently", async ({ page, archive }) => {
  await page.goto("/dashboard/videos");
  const sizeSort = page.getByRole("button", { name: "Sort videos by size, largest first" });
  await sizeSort.click();
  const rows = page.getByRole("list", { name: "Saved videos" }).getByRole("listitem");
  await expect(rows.first()).toContainText("18.0 MB");
  await page.getByRole("button", { name: "Sort videos by size, smallest first" }).click();
  await expect(rows.first()).toContainText("6.0 MB");

  const actions = page.getByRole("button", { name: /More actions for Alice Archive archive clip 001/ });
  await actions.click();
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  await page.getByRole("dialog", { name: "Move this video to trash?" })
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await page.getByRole("tab", { name: "Trash" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Permanently delete this video?" });
  await expect(deleteDialog).toContainText("This action can’t be undone.");
  await deleteDialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Permanently deleted" })).toBeVisible();
  expect(archive.trash.has("1001")).toBe(false);
  expect(archive.videos.some((video) => video.id === "1001")).toBe(false);
});

test("trash can permanently delete every video at once", async ({ page, archive }) => {
  await page.goto("/dashboard/videos");
  for (const title of [
    "Alice Archive archive clip 001",
    "Alice Archive archive clip 002",
  ]) {
    await page.getByRole("button", { name: new RegExp(`More actions for ${title}`) }).click();
    await page.getByRole("button", { name: "Move to trash", exact: true }).click();
    await page.getByRole("dialog", { name: "Move this video to trash?" })
      .getByRole("button", { name: "Move to trash", exact: true })
      .click();
  }
  expect(archive.trash.size).toBe(2);

  await page.getByRole("tab", { name: "Trash" }).click();
  await page.getByRole("button", { name: "Delete all", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Permanently delete all trash?" });
  await expect(dialog).toContainText("all 2 trashed videos");
  await dialog.getByRole("button", { name: "Delete all 2" }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Permanently deleted all 2" })).toBeVisible();
  expect(archive.trash.size).toBe(0);
  expect(archive.videos.some((video) => video.id === "1001" || video.id === "1002")).toBe(false);
});

test("creator import and browser-local settings persist", async ({ page, archive }) => {
  await page.goto("/dashboard/creators");
  await page.getByRole("button", { name: "Import creator" }).click();
  await page.getByRole("textbox", { name: "Creator", exact: true }).fill("@new.creator");
  await page.getByLabel("Maximum video length").fill("3");
  await page.getByRole("button", { name: "Import profile" }).click();
  await expect(page.getByLabel("Import creator profile").getByText("@new.creator", { exact: true })).toBeVisible();
  expect(archive.imports[0]?.username).toBe("new.creator");

  await page.goto("/dashboard/settings");
  const autoplay = page.getByRole("switch", { name: "Autoplay videos" });
  await autoplay.click();
  await page.getByLabel("Default feed").selectOption("bookmarks");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(autoplay).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Default feed")).toHaveValue("bookmarks");
});

test("cross-platform profile links can be created, renamed, unlinked, and restored", async ({ page, archive }) => {
  await page.goto("/dashboard/creators");
  const manager = page.getByRole("region", { name: "Cross-platform profile links" });
  await expect(manager.getByText("No cross-platform profiles are linked yet.")).toBeVisible();

  await manager.getByRole("button", { name: "Link profiles" }).click();
  await manager.getByLabel("First profile URL").fill("https://www.tiktok.com/@alice_everywhere");
  await manager.getByLabel("Second profile URL").fill("https://www.instagram.com/alice_everywhere/");
  await manager.getByLabel("Shared name optional").fill("Alice Everywhere");
  await manager.getByRole("button", { name: "Link profiles" }).click();

  await expect(manager.getByRole("heading", { name: "Alice Everywhere" })).toBeVisible();
  await expect(manager.getByText("TikTok · @alice_everywhere")).toBeVisible();
  await expect(manager.getByText("Instagram · @alice_everywhere")).toBeVisible();
  expect(archive.profileGroups).toHaveLength(1);
  expect(archive.profileGroups[0].members).toHaveLength(2);

  await manager.getByRole("button", { name: "Rename Alice Everywhere" }).click();
  await manager.getByLabel("Creator group name").fill("Alice Linked");
  await manager.getByRole("button", { name: "Save" }).click();
  await expect(manager.getByRole("heading", { name: "Alice Linked" })).toBeVisible();

  await manager.getByRole("button", {
    name: "Unlink Instagram @alice_everywhere from Alice Linked",
  }).click();
  const unlinkedRow = manager.getByRole("listitem").filter({
    has: manager.getByText("Instagram · @alice_everywhere"),
  });
  await expect(unlinkedRow).toBeVisible();
  await unlinkedRow.getByRole("combobox").selectOption({ label: "Alice Linked" });
  await unlinkedRow.getByRole("button", { name: "Link" }).click();
  await expect(manager.getByText("Instagram · @alice_everywhere")).toBeVisible();
  await expect(manager.getByRole("heading", { name: "Unlinked profiles" })).toHaveCount(0);
  expect(archive.profileGroups[0].members).toHaveLength(2);

  expect(archive.requestLog({ method: "POST", pathname: "/api/profile-groups" })).toHaveLength(2);
  expect(archive.requestLog({ method: "PATCH", pathname: "/api/profile-groups/1" })).toHaveLength(1);
  expect(archive.requestLog({
    method: "DELETE",
    pathname: "/api/profile-groups/1/profiles/2",
  })).toHaveLength(1);
});

test("creator menu turns off monitoring, preserves videos, and retries a failed request", async ({ page, archive }) => {
  const savedVideoCount = archive.videos.filter((video) => video.username === "alice.archive").length;
  archive.failNextRequests(
    (request, url) => (
      request.method() === "DELETE"
      && url.pathname === "/api/creators/alice.archive/monitoring"
    ),
    1,
    503,
    "Monitoring service unavailable",
  );

  await page.goto("/dashboard/creators");
  const creatorCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Alice Archive" }),
  });
  const menuTrigger = creatorCard.getByRole("button", { name: "More actions for alice.archive" });
  await menuTrigger.click();
  await creatorCard.getByRole("button", { name: "Turn off monitoring" }).click();

  const dialog = page.getByRole("dialog", { name: "Turn off monitoring for @alice.archive?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("132 saved videos stay in the archive");
  await dialog.getByRole("button", { name: "Turn off monitoring" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Monitoring service unavailable");
  expect(archive.creators.find((creator) => creator.username === "alice.archive")?.enabled).toBe(true);

  await dialog.getByRole("button", { name: "Turn off monitoring" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({
    hasText: "Monitoring turned off for @alice.archive. Saved videos were kept.",
  })).toBeVisible();
  await expect(creatorCard.getByText("Saved archive only")).toBeVisible();
  await expect(creatorCard.getByText("Not monitored")).toBeVisible();
  expect(archive.creators.find((creator) => creator.username === "alice.archive")?.enabled).toBe(false);
  expect(archive.videos.filter((video) => video.username === "alice.archive")).toHaveLength(savedVideoCount);
  expect(archive.trash.size).toBe(0);
  expect(archive.requestLog({
    method: "DELETE",
    pathname: "/api/creators/alice.archive/monitoring",
  })).toHaveLength(2);

  await menuTrigger.click();
  await expect(creatorCard.getByRole("button", { name: "Turn off monitoring" })).toHaveCount(0);
});
