import { test, expect } from "./fixtures/archive";

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
