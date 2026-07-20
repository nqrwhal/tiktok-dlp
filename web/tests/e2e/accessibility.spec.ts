import { test, expect } from "./fixtures/archive";
import { expectNoSeriousA11yViolations } from "./helpers";

const stableRoutes = [
  "/creator?creator=creator-alice",
  "/dashboard",
  "/dashboard/videos",
  "/dashboard/creators",
  "/dashboard/settings",
];

test("stable routes have no serious or critical WCAG A/AA violations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one engine is sufficient for deterministic Axe rules");
  for (const route of stableRoutes) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await expect(page).toHaveTitle(/\S+/);
    await expectNoSeriousA11yViolations(page);
  }
});

test("confirmation dialogs have no serious or critical WCAG A/AA violations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one engine is sufficient for deterministic Axe rules");
  await page.goto("/dashboard/videos");
  await page.getByRole("button", { name: /More actions for Alice Archive archive clip 001/ }).click();
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.goto("/dashboard/creators");
  const creatorCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Alice Archive" }),
  });
  await creatorCard.getByRole("button", { name: "More actions for alice.archive" }).click();
  await creatorCard.getByRole("button", { name: "Turn off monitoring" }).click();
  await expect(page.getByRole("dialog", { name: "Turn off monitoring for @alice.archive?" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("feed excludes only the unavailable caption-track rule", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one engine is sufficient for deterministic Axe rules");
  await page.goto("/?video=1001");
  await expect(page.getByRole("heading", { name: "Saved video feed" })).toBeVisible();
  await expect(page).toHaveTitle(/\S+/);
  await expectNoSeriousA11yViolations(page);
});
