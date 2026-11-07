import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "wfhelper:sharedFilters:v1";

let storage = new Map<string, string>();

async function loadFilters(seed: Record<string, string> = {}) {
  storage = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
  vi.resetModules();
  return await import("../../../src/stores/filters.js");
}

function saved(): Record<string, Record<string, unknown>> {
  return JSON.parse(storage.get(STORAGE_KEY) ?? "{}");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared filter persistence", () => {
  it("restores valid fields for every scope without restoring search text", async () => {
    const filters = await loadFilters();
    filters.updateSharedFilters("inventory", {
      search: "loki",
      mastered: "yes",
      minimumDucats: 45,
    });
    filters.updateSharedFilters("foundry", {
      search: "blueprint",
      masteredMode: "not_mastered",
      sortBy: "count",
      sortDirection: "desc",
      foundryState: "buildable_sets",
    });

    expect(saved().inventory).not.toHaveProperty("search");
    expect(saved().foundry).not.toHaveProperty("search");

    vi.resetModules();
    const restored = await import("../../../src/stores/filters.js");
    expect(get(restored.sharedFilters("inventory"))).toMatchObject({
      search: "",
      masteredMode: "all",
      mastered: "yes",
      minimumDucats: 45,
    });
    expect(get(restored.sharedFilters("foundry"))).toMatchObject({
      search: "",
      masteredMode: "not_mastered",
      sortBy: "count",
      sortDirection: "desc",
      foundryState: "buildable_sets",
    });
  });

  it("ignores invalid saved fields and falls back to each scope default", async () => {
    const filters = await loadFilters({
      [STORAGE_KEY]: JSON.stringify({
        inventory: {
          search: "stale query",
          masteredMode: "sometimes",
          minimumAmount: 1,
          minimumPlatinum: -30,
          favorite: "maybe",
        },
        foundry: { sortBy: "invalid", sortDirection: "sideways" },
      }),
    });

    expect(get(filters.sharedFilters("inventory"))).toMatchObject({
      search: "",
      masteredMode: "all",
      minimumAmount: 0,
      minimumPlatinum: 0,
      favorite: "all",
    });
    expect(get(filters.sharedFilters("foundry"))).toMatchObject({
      sortBy: "count",
      sortDirection: "desc",
    });
  });

  it("persists resetSharedFilters and restores the scope defaults after reload", async () => {
    const filters = await loadFilters();
    filters.updateSharedFilters("inventory", {
      search: "loki",
      minimumPlatinum: 100,
    });
    filters.resetSharedFilters("inventory");

    expect(get(filters.sharedFilters("inventory"))).toMatchObject({
      search: "",
      minimumPlatinum: 0,
    });
    expect(saved().inventory).toMatchObject({
      minimumPlatinum: 0,
    });
    expect(saved().inventory).not.toHaveProperty("search");

    vi.resetModules();
    const restored = await import("../../../src/stores/filters.js");
    expect(get(restored.sharedFilters("inventory"))).toMatchObject({
      search: "",
      minimumPlatinum: 0,
    });
  });

  it("drops an inventory masteredMode saved before the selector was removed", async () => {
    const filters = await loadFilters({
      [STORAGE_KEY]: JSON.stringify({
        inventory: { masteredMode: "not_mastered" },
        foundry: { masteredMode: "mastered" },
      }),
    });

    expect(get(filters.sharedFilters("inventory")).masteredMode).toBe("all");
    expect(get(filters.sharedFilters("foundry")).masteredMode).toBe("mastered");
  });
});
