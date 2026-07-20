import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures/archive";

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `page scroll width ${dimensions.scrollWidth}px`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

export async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // The archive contract has no captions or caption sidecar URL to render.
    .disableRules(["video-caption"])
    .analyze();
  const violations = results.violations.filter((violation) => (
    violation.impact === "serious" || violation.impact === "critical"
  ));
  expect(violations, formatAxeViolations(violations)).toEqual([]);
}

export async function revealFeedControls(page: Page) {
  const trigger = page.getByRole("button", { name: /^Show controls for / });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("button", { name: /^(?:Bookmark|Remove bookmark) / }).first()).toBeVisible();
}

export async function currentFeedCardId(page: Page) {
  const button = page.getByRole("button", { name: /^(?:Bookmark|Remove bookmark) / }).first();
  return button.locator("xpath=ancestor::*[@data-video-id][1]").getAttribute("data-video-id");
}

function formatAxeViolations(violations: Array<{ id: string; help: string; nodes: Array<{ target: unknown }> }>) {
  if (!violations.length) return "No serious or critical WCAG A/AA violations";
  return violations.map((violation) => (
    `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${JSON.stringify(node.target)}`).join("\n")}`
  )).join("\n");
}
