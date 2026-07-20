import { test, expect } from "./fixtures/archive";
import { expectNoHorizontalOverflow, revealFeedControls } from "./helpers";

test("feed playback, mute, bookmark, seek, and action menu controls work", async ({ page, archive }) => {
  await page.goto("/?video=1001");
  await revealFeedControls(page);

  const soundToggle = page.getByRole("button", { name: /^(?:Turn sound on|Mute videos)$/ });
  const initialSoundLabel = await soundToggle.getAttribute("aria-label");
  await soundToggle.click();
  await expect(soundToggle).toHaveAttribute(
    "aria-label",
    initialSoundLabel === "Mute videos" ? "Turn sound on" : "Mute videos",
  );
  await page.getByRole("button", { name: "Pause video" }).click();
  await expect(page.getByRole("button", { name: "Play video" }).first()).toBeVisible();

  await page.getByRole("button", { name: /^Bookmark / }).click();
  await expect.poll(() => archive.bookmarks.has("1001")).toBe(true);
  const seek = page.getByRole("slider", { name: /^Seek / });
  await seek.fill("50");
  await expect(seek).toHaveValue("50");

  const more = page.getByRole("button", { name: /^More actions for / });
  await more.click();
  await expect(page.getByRole("link", { name: "Original post" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Original post" })).toBeHidden();
  await expect(more).toBeFocused();
});

test("mobile dashboard drawer traps focus, closes on Escape, and restores focus", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile navigation contract");
  await page.goto("/dashboard");
  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await menuButton.click();

  const navigation = page.getByRole("navigation", { name: "Dashboard navigation" });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await page.keyboard.press("Escape");

  await expect(navigation).toBeHidden();
  await expect(menuButton).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("creator picker keeps its popup in view and honors ArrowUp", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single deterministic keyboard and mid-width check");
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto("/dashboard/videos");

  const trigger = page.getByRole("button", { name: "Creator filter: All creators" });
  await trigger.focus();
  await trigger.press("ArrowUp");

  await expect(page.getByRole("option", { name: "@cora.cooks", exact: true })).toBeFocused();
  await expectNoHorizontalOverflow(page);
});
