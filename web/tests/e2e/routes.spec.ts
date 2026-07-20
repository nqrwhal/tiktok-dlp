import { test, expect } from "./fixtures/archive";
import { expectNoHorizontalOverflow } from "./helpers";

const routes = [
  { path: "/", heading: "Saved video feed" },
  { path: "/creator?creator=creator-alice", heading: "Alice Archive" },
  { path: "/dashboard", heading: "Dashboard" },
  { path: "/dashboard/videos", heading: "Videos" },
  { path: "/dashboard/creators", heading: "Creators" },
  { path: "/dashboard/settings", heading: "Settings" },
];

for (const route of routes) {
  test(`${route.path} renders without browser errors or overflow`, async ({ page, diagnostics }) => {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(diagnostics.pageErrors, "uncaught page errors").toEqual([]);
    expect(diagnostics.consoleErrors, "browser console errors").toEqual([]);
  });
}

test("dashboard navigation marks the current route without an inset or generated edge", async ({ page }) => {
  await page.goto("/dashboard/videos");
  const activeLink = page.locator('nav a[aria-current="page"]');
  await expect(activeLink).toHaveText(/Videos/);
  const decoration = await activeLink.evaluate((element) => ({
    shadow: getComputedStyle(element).boxShadow,
    before: getComputedStyle(element, "::before").content,
    after: getComputedStyle(element, "::after").content,
  }));
  expect(decoration.shadow).not.toContain("inset");
  expect(["none", "normal", "\"\""]).toContain(decoration.before);
  expect(["none", "normal", "\"\""]).toContain(decoration.after);
});
