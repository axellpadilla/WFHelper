import { test, expect, type Locator, type Page } from "@playwright/test";

import { FILTER_CONTROL_SUPPORT } from "../src/lib/filters";
import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Derived from the view's own support list instead of a literal that drifts
// whenever a filter control is added: search and sort from the header bar plus
// the advanced controls, all editable from either bar's popover.
const INVENTORY_CONTROLS = FILTER_CONTROL_SUPPORT.inventory.length;

function toggles(page: Page): Locator {
  return page.locator('[data-filter-customize-toggle="inventory"]');
}

function popovers(page: Page): Locator {
  return page.locator('[data-filter-customize="inventory"]');
}

test.describe("Filter customize popover", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-filter-customize-");
    page = harness.page;
    // Wide enough that a popover under the header toggle clears the second bar.
    await setLayoutViewport(page, 1600, 1000);
    await openView(page, "inventory");
    await page.locator('[data-tour-tab="all_parts"]').click();
    await expect(toggles(page).first()).toBeVisible({ timeout: 60_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test.beforeEach(async () => {
    await page.keyboard.press("Escape");
    await expect(popovers(page)).toHaveCount(0);
  });

  test("the header toggle opens a popover listing every inventory control", async () => {
    await toggles(page).first().click();

    const popover = popovers(page);
    await expect(popover).toHaveCount(1);
    await expect(popover.locator("[data-filter-control]")).toHaveCount(INVENTORY_CONTROLS);

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("unticking a control drops it from the bar and ticking it back restores it", async () => {
    // Sort owns the only select in the header bar, so its row is visible proof.
    const sortSelect = page.locator('[data-tour="filter-bar"]').first().locator("select");
    await expect(sortSelect).toHaveCount(1);

    await toggles(page).first().click();
    const visible = popovers(page).locator('[data-filter-control="sort"] input[type="checkbox"]');
    await expect(visible).toBeChecked();

    await visible.uncheck();
    await expect(sortSelect).toHaveCount(0);

    await visible.check();
    await expect(sortSelect).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(popovers(page)).toHaveCount(0);
  });

  test("the two bars never hold a popover at the same time", async () => {
    // Opening from the header reveals the advanced row, which carries its own toggle.
    await toggles(page).first().click();
    await expect(toggles(page)).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(popovers(page)).toHaveCount(0);

    await toggles(page).nth(1).click();
    await expect(popovers(page)).toHaveCount(1);
    await expect(toggles(page).nth(1)).toHaveAttribute("aria-expanded", "true");

    await toggles(page).first().click();
    await expect(popovers(page)).toHaveCount(1);
    await expect(toggles(page).first()).toHaveAttribute("aria-expanded", "true");
    await expect(toggles(page).nth(1)).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Escape");
    await expect(popovers(page)).toHaveCount(0);
    await expect(toggles(page).first()).toHaveAttribute("aria-expanded", "false");
  });
});
