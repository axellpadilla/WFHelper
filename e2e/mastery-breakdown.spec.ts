import { expect, test } from "@playwright/test";

import { DB_GET_MASTERY } from "../config/shared/ipcChannels";
import type { MasteryData } from "../src/types/inventory";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const mastery: MasteryData = {
  items: [],
  stats: {
    total: 340,
    mastered: 124,
    inProgress: 9,
    missing: 207,
    byCategory: {
      Warframes: { total: 100, mastered: 61, inProgress: 8, missing: 31 },
      Primary: { total: 40, mastered: 9, inProgress: 1, missing: 30 },
      Secondary: { total: 50, mastered: 15, inProgress: 0, missing: 35 },
      Melee: { total: 80, mastered: 25, inProgress: 0, missing: 55 },
      Companions: { total: 10, mastered: 2, inProgress: 0, missing: 8 },
      Archwing: { total: 40, mastered: 10, inProgress: 0, missing: 30 },
      Amps: { total: 9, mastered: 1, inProgress: 0, missing: 8 },
      Necramech: { total: 2, mastered: 0, inProgress: 0, missing: 2 },
      Misc: { total: 9, mastered: 1, inProgress: 0, missing: 8 },
    },
    completion: {
      starChart: {
        normal: { done: 123, total: 238 },
        junctions: { done: 13, total: 13 },
        steelPath: { done: 12, total: 238 },
        steelPathJunctions: { done: 1, total: 13 },
      },
      intrinsics: { railjack: { done: 30, total: 50 }, drifter: { done: 20, total: 40 } },
    },
  },
};

test("mastery breakdown aligns counts and persists its ring display", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  const pageErrors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-mastery-breakdown-", {
      storage: { "mastery-breakdown-expanded": "1", wf_hide_founder_mastery_items: "0" },
      onPage: (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
      },
    });
    const { app, page } = harness;
    await evaluateInMain(
      app,
      ({ ipcMain }, payload) => {
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, () => payload.data);
      },
      { channel: DB_GET_MASTERY, data: mastery },
    );
    await page.reload();
    await setLayoutViewport(page, 1440, 1100);
    await openView(page, "mastery");
    const row = page.locator('[data-mastery-breakdown-row="Warframes"]');
    await expect(row.locator("[data-breakdown-count]")).toHaveText("61/100 (61.0%)");
    const bars = page.locator('[data-breakdown-style="bars"]');
    const rings = page.locator('[data-breakdown-style="rings"]');
    await expect(bars).toHaveAttribute("aria-pressed", "true");
    const geometry = await page.locator("[data-mastery-breakdown-row]").evaluateAll((rows) =>
      rows.slice(0, 3).map((element) => {
        const category = element
          .querySelector("[data-breakdown-category]")!
          .getBoundingClientRect();
        const count = element.querySelector("[data-breakdown-count]")!.getBoundingClientRect();
        const progress = element
          .querySelector("[data-breakdown-progress]")!
          .getBoundingClientRect();
        return {
          categoryRight: category.right,
          countX: count.x,
          countRight: count.right,
          progressX: progress.x,
          progressWidth: progress.width,
        };
      }),
    );
    for (const actual of geometry) {
      expect(actual.countX).toBeGreaterThan(actual.categoryRight);
      expect(actual.progressX).toBeGreaterThan(actual.countRight);
      expect(actual.progressX).toBeCloseTo(geometry[0].progressX, 1);
      expect(actual.progressWidth).toBeCloseTo(geometry[0].progressWidth, 1);
    }
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("mastery-bars.png"),
    });
    await rings.click();
    await expect(row).toHaveAttribute("data-display", "rings");
    await expect(row.locator("circle")).toHaveCount(2);
    await expect(row.locator("circle").last()).toHaveAttribute("stroke-dashoffset", "39");
    const assertRingLayout = async () => {
      const tiles = await page.locator("[data-mastery-breakdown-row]").evaluateAll((rows) =>
        rows.map((element) => {
          const circle = element.querySelector("svg")!.getBoundingClientRect();
          const label = element.querySelector("[data-breakdown-category]")!.getBoundingClientRect();
          const count = element.querySelector("[data-breakdown-count]")!.getBoundingClientRect();
          return {
            x: circle.x,
            y: circle.y,
            labelBelow: label.top >= circle.bottom,
            countBelow: count.top >= label.bottom,
            centered: Math.abs(label.x + label.width / 2 - (circle.x + circle.width / 2)) < 1,
          };
        }),
      );
      for (const tile of tiles) {
        expect(tile.labelBelow).toBe(true);
        expect(tile.countBelow).toBe(true);
        expect(tile.centered).toBe(true);
      }
      for (const first of [0, 9, 13]) {
        expect(tiles[first + 1].x).toBeGreaterThan(tiles[first].x);
        expect(tiles[first + 1].y).toBeCloseTo(tiles[first].y, 1);
      }
    };
    await assertRingLayout();
    const complete = page.locator('[data-mastery-breakdown-row="Junctions"]');
    await expect(complete.locator("svg text")).toHaveText("100.0%");
    await expect(complete.locator('circle[pathLength="100"]')).toHaveAttribute(
      "stroke-dashoffset",
      "0",
    );
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("mastery-rings.png"),
    });
    await page.reload();
    await openView(page, "mastery");
    await expect(rings).toHaveAttribute("aria-pressed", "true");
    for (const width of [1920, 900, 780]) {
      await setLayoutViewport(page, width, 1100);
      await expect(row).toHaveAttribute("data-display", "rings");
      const breakdownRows = page.locator("[data-mastery-breakdown-row]");
      await expect(breakdownRows).toHaveCount(15);
      await assertRingLayout();
      const clippedRowStarts = await page
        .locator('[data-summary-strip="mastery"]')
        .evaluate((strip) => {
          const bounds = strip.getBoundingClientRect();
          return (
            getComputedStyle(strip).overflow === "hidden" &&
            Array.from(strip.querySelectorAll("[data-summary-item]")).every((item) => {
              const rect = item.getBoundingClientRect();
              if (Math.abs(rect.left - bounds.left) > 1) return true;
              const divider = getComputedStyle(item, "::before");
              return (
                rect.left + Number.parseFloat(divider.left) + Number.parseFloat(divider.width) <=
                bounds.left
              );
            })
          );
        });
      expect(clippedRowStarts).toBe(true);
      const summaryTextFits = await page
        .locator('[data-summary-strip="mastery"]')
        .evaluate((strip) => {
          const bounds = strip.getBoundingClientRect();
          return Array.from(strip.querySelectorAll("span")).every((label) => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return Array.from(range.getClientRects()).every(
              (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
            );
          });
        });
      expect(summaryTextFits).toBe(true);
      await expect(
        page.locator('[data-summary-strip="mastery"] [data-summary-item="mastered"] span').last(),
      ).toHaveText("Mastered");
      expect(
        await breakdownRows.evaluateAll((rows) =>
          rows.every((element) => element.scrollWidth <= element.clientWidth + 1),
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: test.info().outputPath(`mastery-rings-${width}.png`),
      });
      await bars.click();
      expect(
        await breakdownRows.evaluateAll((rows) =>
          rows.every((element) => element.scrollWidth <= element.clientWidth + 1),
        ),
      ).toBe(true);
      await rings.click();
    }
    expect(pageErrors).toEqual([]);
  } finally {
    if (harness) await closeElectronTestHarness(harness);
  }
});
