import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createXdgGlobalShortcutsPortal,
  electronToXdgTrigger,
  ensurePortalDesktopFile,
  type PortalShortcut,
  type XdgGlobalShortcutsBindings,
} from "../../services/xdgGlobalShortcutsPortal";

function createHarness() {
  let onActivated: ((id: string) => void) | null = null;
  let onSession: ((handle: string | null) => void) | null = null;
  const fallbackCallbacks = new Map<string, () => void>();
  const bindings: XdgGlobalShortcutsBindings = {
    connect: vi.fn(() => "connection"),
    getVersion: vi.fn(() => 1),
    registerApp: vi.fn(),
    subscribeActivated: vi.fn((_connection, callback) => {
      onActivated = callback;
      return "activated-subscription";
    }),
    createSession: vi.fn((_connection, callback) => {
      onSession = callback;
    }),
    bindShortcuts: vi.fn(),
    closeSession: vi.fn(),
    unsubscribe: vi.fn(),
    iterateMainContext: vi.fn(),
  };
  const fallback = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      fallbackCallbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => fallbackCallbacks.delete(accelerator)),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const shortcut = createXdgGlobalShortcutsPortal({
    fallback,
    log,
    bindings,
    platform: "linux",
    desktopFile: { existsSync: () => true },
  });
  return {
    shortcut,
    fallback,
    fallbackCallbacks,
    bindings,
    log,
    activate(id: string) {
      onActivated?.(id);
    },
    startSession(handle = "/org/freedesktop/portal/desktop/session/wfhelper/1") {
      onSession?.(handle);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("electronToXdgTrigger", () => {
  it.each([
    ["F8", "F8"],
    ["Control+Shift+F7", "CTRL+SHIFT+F7"],
    ["CommandOrControl+Alt+a", "CTRL+ALT+a"],
    ["Super+1", "LOGO+1"],
    ["Enter", "Return"],
    ["Backspace", "BackSpace"],
    ["PageUp", "Page_Up"],
    ["PageDown", "Page_Down"],
    ["Comma", "comma"],
    ["Period", "period"],
    ["Minus", "minus"],
    ["Equal", "equal"],
  ])("converts %s to %s", (accelerator, trigger) => {
    expect(electronToXdgTrigger(accelerator)).toBe(trigger);
  });

  it("rejects unknown keys and malformed modifiers", () => {
    expect(electronToXdgTrigger("Control+F25")).toBeNull();
    expect(electronToXdgTrigger("Control+UnsupportedKey")).toBeNull();
    expect(electronToXdgTrigger("Control+Bogus+F8")).toBeNull();
    expect(electronToXdgTrigger("Control++F8")).toBeNull();
  });
});

describe("ensurePortalDesktopFile", () => {
  it("does nothing when the user desktop file already exists", () => {
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();
    const result = ensurePortalDesktopFile({
      env: { XDG_DATA_HOME: "/tmp/wfhelper-data" },
      existsSync: (file) => file === "/tmp/wfhelper-data/applications/wfhelper.desktop",
      mkdirSync,
      writeFileSync,
    });

    expect(result).toBe("/tmp/wfhelper-data/applications/wfhelper.desktop");
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("creates a minimal user desktop file when neither location exists", () => {
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();
    const result = ensurePortalDesktopFile({
      env: { XDG_DATA_HOME: "/tmp/wfhelper-data" },
      existsSync: () => false,
      mkdirSync,
      writeFileSync,
    });

    expect(mkdirSync).toHaveBeenCalledWith("/tmp/wfhelper-data/applications", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/wfhelper-data/applications/wfhelper.desktop",
      "[Desktop Entry]\nType=Application\nName=WFHelper\nNoDisplay=true\nExec=wfhelper\n",
      "utf8",
    );
    expect(result).toBe("/tmp/wfhelper-data/applications/wfhelper.desktop");
  });

  it("uses the system desktop entry without creating a user copy", () => {
    const writeFileSync = vi.fn();
    const result = ensurePortalDesktopFile({
      env: { XDG_DATA_HOME: "/tmp/wfhelper-data" },
      existsSync: (file) => file === "/usr/share/applications/wfhelper.desktop",
      writeFileSync,
    });

    expect(result).toBe("/usr/share/applications/wfhelper.desktop");
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("XDG GlobalShortcuts portal backend", () => {
  it("registers fallback immediately and batches F8/F7/F6 into one BindShortcuts call", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const callback = vi.fn();

    expect(harness.shortcut.register("F8", callback)).toBe(true);
    expect(harness.shortcut.register("Control+Shift+F7", callback)).toBe(true);
    expect(harness.shortcut.register("Alt+F6", callback)).toBe(true);
    expect(harness.fallback.register).toHaveBeenCalledTimes(3);
    expect(harness.bindings.registerApp).toHaveBeenCalledOnce();
    expect(harness.bindings.bindShortcuts).not.toHaveBeenCalled();

    harness.startSession();
    vi.advanceTimersByTime(25);

    expect(harness.bindings.bindShortcuts).toHaveBeenCalledOnce();
    const shortcuts = vi.mocked(harness.bindings.bindShortcuts).mock.calls[0][2];
    expect(shortcuts.map(({ trigger }) => trigger).sort()).toEqual([
      "ALT+F6",
      "CTRL+SHIFT+F7",
      "F8",
    ]);
    vi.advanceTimersByTime(50);
    expect(harness.bindings.iterateMainContext).toHaveBeenCalled();
  });

  it("dispatches portal Activated signals and deduplicates the X11 callback for 150ms", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const callback = vi.fn();
    harness.shortcut.register("F8", callback);
    harness.startSession();
    vi.advanceTimersByTime(25);
    const shortcuts = vi.mocked(harness.bindings.bindShortcuts).mock
      .calls[0][2] as PortalShortcut[];
    const fallbackCallback = harness.fallbackCallbacks.get("F8");
    expect(fallbackCallback).toBeDefined();

    fallbackCallback?.();
    harness.activate(shortcuts[0].id);
    expect(callback).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(150);
    harness.activate(shortcuts[0].id);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("closes the session and stops polling after the final unregister", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.startSession();
    vi.advanceTimersByTime(25);

    harness.shortcut.unregister("F8");

    expect(harness.fallback.unregister).toHaveBeenCalledWith("F8");
    expect(harness.bindings.closeSession).toHaveBeenCalledWith(
      "connection",
      "/org/freedesktop/portal/desktop/session/wfhelper/1",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the portal session on dispose", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.startSession("/session/to-dispose");
    vi.advanceTimersByTime(25);

    harness.shortcut.dispose();

    expect(harness.bindings.closeSession).toHaveBeenCalledWith("connection", "/session/to-dispose");
    expect(harness.fallback.unregister).toHaveBeenCalledWith("F8");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recreates the portal session when shortcuts change after the initial bind", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.startSession("/session/first");
    vi.advanceTimersByTime(25);
    expect(harness.bindings.bindShortcuts).toHaveBeenCalledTimes(1);

    harness.shortcut.register("F7", vi.fn());
    vi.advanceTimersByTime(25);

    expect(harness.bindings.closeSession).toHaveBeenCalledWith("connection", "/session/first");
    expect(harness.bindings.createSession).toHaveBeenCalledTimes(2);

    harness.startSession("/session/second");
    expect(harness.bindings.bindShortcuts).toHaveBeenCalledTimes(2);
    const secondCallShortcuts = vi.mocked(harness.bindings.bindShortcuts).mock.calls[1][2];
    expect(secondCallShortcuts.map(({ trigger }) => trigger).sort()).toEqual(["F7", "F8"]);
  });
});
