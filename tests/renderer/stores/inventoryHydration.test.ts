import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InventoryBaseItem, MetricNeeds } from "../../../src/lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";
import type { HydrationContext } from "../../../src/stores/hydration/hydrateItemMetrics.js";

const hydrateItemMetricsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/stores/hydration/hydrateItemMetrics.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/stores/hydration/hydrateItemMetrics.js")>();
  return {
    ...actual,
    hydrateItemMetrics: hydrateItemMetricsMock,
  };
});

vi.mock("../../../src/lib/wfm/wfmPrice.js", () => ({}));

vi.mock("../../../src/lib/wfm/orderBook.js", () => ({}));

vi.mock("../../../src/lib/wfm/orderSummaryRemote.js", () => ({}));

function makeItem(index: number): InventoryBaseItem {
  return {
    name: `Test Item ${index}`,
    internalName: `/Lotus/Test/Item${index}`,
    category: "Misc",
    categoryLabel: "Misc",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    inventoryGroup: "misc",
    partType: "normal",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: `test_item_${index}`,
    marketThumb: null,
    subtype: null,
  };
}

describe("createInventoryHydrationController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hydrateItemMetricsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates queued items in fixed batches and ignores duplicate enqueue attempts", async () => {
    const { createInventoryHydrationController } =
      await import("../../../src/stores/inventoryHydration.js");
    const { HYDRATION_BATCH_SIZE, HYDRATION_TICK_MS } =
      await import("../../../src/stores/hydration/hydrationTypes.js");
    const hydratedKeys: string[] = [];

    hydrateItemMetricsMock.mockImplementation(
      async (ctx: HydrationContext, item: InventoryBaseItem) => {
        ctx.markPending(item.internalName);
        hydratedKeys.push(item.internalName);
        await Promise.resolve();
        ctx.clearPending(item.internalName);
      },
    );

    const controller = createInventoryHydrationController();
    const items = Array.from({ length: HYDRATION_BATCH_SIZE * 2 + 1 }, (_, index) =>
      makeItem(index),
    );
    const lookup: WfmItemsLookup = {};
    const needs: MetricNeeds = { price: true, ducats: false, orders: false };

    controller.enqueue(items, lookup, needs);
    controller.enqueue(items, lookup, needs);

    expect(hydratedKeys).toHaveLength(HYDRATION_BATCH_SIZE);

    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS);

    expect(hydratedKeys).toHaveLength(HYDRATION_BATCH_SIZE * 2);

    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS);

    expect(hydratedKeys).toHaveLength(items.length);
    expect(new Set(hydratedKeys).size).toBe(items.length);
  });

  it("batches metric flushes while the queue drains and flushes the tail on drain", async () => {
    const { createInventoryHydrationController } =
      await import("../../../src/stores/inventoryHydration.js");
    const { HYDRATION_BATCH_SIZE, HYDRATION_TICK_MS, METRIC_FLUSH_MS, METRIC_FLUSH_BUSY_MS } =
      await import("../../../src/stores/hydration/hydrationTypes.js");

    hydrateItemMetricsMock.mockImplementation(
      async (ctx: HydrationContext, item: InventoryBaseItem) => {
        ctx.queueMetricPatch(item.internalName, {
          platinum: 1,
          ducats: null,
          slug: item.marketSlug,
          thumb: null,
          icon: null,
          hasPrice: true,
          hasDucats: true,
          hasMeta: true,
        });
        await Promise.resolve();
      },
    );

    const controller = createInventoryHydrationController();
    const storeUpdates: number[] = [];
    const unsubscribe = controller.metricsByKey.subscribe((metrics) => {
      const size = Object.keys(metrics).length;
      if (size > 0) storeUpdates.push(size);
    });

    // Three batches: the queue stays busy past the idle flush delay.
    const items = Array.from({ length: HYDRATION_BATCH_SIZE * 2 + 1 }, (_, index) =>
      makeItem(index),
    );
    controller.enqueue(items, {}, { price: true, ducats: false, orders: false });

    // The idle delay must NOT flush while later batches are still queued.
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS);
    expect(storeUpdates).toHaveLength(0);

    // Drain happens well before the busy delay; the tail must not wait for it.
    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS * 2);
    expect(storeUpdates).toEqual([items.length]);

    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_BUSY_MS);
    expect(storeUpdates).toEqual([items.length]);

    unsubscribe();
  });

  it("re-queues a row for a network pass after a no-network pass stamped it without a price", async () => {
    const { createInventoryHydrationController } =
      await import("../../../src/stores/inventoryHydration.js");
    const { HYDRATION_TICK_MS, METRIC_FLUSH_MS } =
      await import("../../../src/stores/hydration/hydrationTypes.js");
    const passes: Array<boolean | undefined> = [];

    hydrateItemMetricsMock.mockImplementation(
      async (ctx: HydrationContext, item: InventoryBaseItem, _lookup, needs: MetricNeeds) => {
        passes.push(needs.network);
        // What the real no-network pass does for a row the snapshot did not price.
        ctx.queueMetricPatch(item.internalName, {
          platinum: null,
          ducats: null,
          slug: item.marketSlug,
          thumb: null,
          icon: null,
          hasPrice: true,
          hasDucats: true,
          hasMeta: true,
        });
        await Promise.resolve();
      },
    );

    const controller = createInventoryHydrationController();
    const item = makeItem(1);
    controller.enqueue([item], {}, { price: true, ducats: false, orders: false, network: false });
    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS + METRIC_FLUSH_MS);

    // The card scrolls into view: this pass may fetch, so it must not be skipped.
    controller.enqueue([item], {}, { price: true, ducats: false, orders: false, network: true });
    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS);

    expect(passes).toEqual([false, true]);
  });
});
