import { afterEach, describe, expect, it, vi } from "vitest";

async function loadGate(options: {
  search?: string;
  storage?: Record<string, string>;
}): Promise<typeof import("../../../src/stores/app.js")> {
  vi.stubGlobal("location", { search: options.search ?? "" });
  const mem = new Map(Object.entries(options.storage ?? {}));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  // The gate is read once at module load, like the other persisted stores.
  vi.resetModules();
  return import("../../../src/stores/app.js");
}

describe("setup gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("shows setup when the main process seeds setup=0", async () => {
    const app = await loadGate({ search: "?setup=0" });
    expect(app.isSetupCompleted()).toBe(false);
  });

  it("skips setup when the main process seeds setup=1", async () => {
    const app = await loadGate({ search: "?setup=1" });
    expect(app.isSetupCompleted()).toBe(true);
  });

  it("seeds the first view from the main-process flag", async () => {
    const app = await loadGate({ search: "?setup=1" });
    const { get } = await import("svelte/store");
    expect(get(app.currentView)).toBe("inventory");
  });

  it("honors a v2 key from a build before main-process state existed", async () => {
    const app = await loadGate({
      search: "?setup=0",
      storage: { "setup-completed-v2": "1" },
    });
    expect(app.isSetupCompleted()).toBe(true);
  });

  it("does not treat the legacy key as v2 completion", async () => {
    const app = await loadGate({
      search: "?setup=0",
      storage: { "setup-completed": "1" },
    });
    expect(app.isSetupCompleted()).toBe(false);
  });

  it("keeps safe-mode launches working alongside the setup seed", async () => {
    const app = await loadGate({ search: "?safe=1&setup=1" });
    expect(app.isSetupCompleted()).toBe(true);
  });
});
