import { describe, expect, it, vi } from "vitest";

import type { GlibSessionBus } from "../../services/glibSessionBus";
import {
  createGnomeNativeShortcuts,
  electronAcceleratorToGnomeBinding,
  formatCustomKeybindings,
  isGnomeSession,
  parseCustomKeybindings,
  parseGsettingsString,
} from "../../services/gnomeNativeShortcuts";

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding`;
const ROOT = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
const SIGNAL_MARKER = "org.wfhelper.Hotkeys";

function unquote(value: string): string {
  const match = /^'((?:[^'\\]|\\.)*)'$/.exec(value.trim());
  return match ? match[1].replace(/\\(.)/g, "$1") : value;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface FakeStore {
  list: string[];
  entries: Map<string, Record<string, string>>;
}

function createHarness(
  initial: {
    list?: string[];
    entries?: Record<string, Record<string, string>>;
  } = {},
) {
  const store: FakeStore = {
    list: [...(initial.list ?? [])],
    entries: new Map(
      Object.entries(initial.entries ?? {}).map(([path, entry]) => [path, { ...entry }]),
    ),
  };
  const calls: string[][] = [];
  const exec = (args: string[]): string => {
    calls.push(args);
    const [command, target, key, value] = args;
    if (command === "list-keys") return "binding\ncommand\nenable-in-lockscreen\nname";
    if (target === MEDIA_KEYS && key === "custom-keybindings") {
      if (command === "get") return formatCustomKeybindings(store.list);
      if (command === "set") {
        store.list = parseCustomKeybindings(value);
        return "";
      }
    }
    const prefix = `${CUSTOM_SCHEMA}:`;
    if (target.startsWith(prefix)) {
      const path = target.slice(prefix.length);
      const entry = store.entries.get(path) ?? {};
      if (command === "get") return quote(entry[key] ?? "");
      if (command === "set") {
        entry[key] = unquote(value);
        store.entries.set(path, entry);
        return "";
      }
      if (command === "reset") {
        delete entry[key];
        store.entries.set(path, entry);
        return "";
      }
    }
    throw new Error(`unexpected gsettings call: ${args.join(" ")}`);
  };

  const fallbackCallbacks = new Map<string, () => void>();
  const fallback = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      fallbackCallbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => fallbackCallbacks.delete(accelerator)),
  };
  const subscriptions: Array<(argument: string) => void> = [];
  const bus: GlibSessionBus = {
    subscribe: vi.fn((_interface, _member, _path, callback) => {
      subscriptions.push(callback);
    }),
    dispose: vi.fn(),
  };
  let time = 1_000;
  const log = { info: vi.fn(), warn: vi.fn() };
  const shortcut = createGnomeNativeShortcuts({
    log,
    fallback,
    exec,
    bus,
    now: () => time,
    hasGdbus: () => true,
  });

  return {
    shortcut,
    store,
    calls,
    fallback,
    bus,
    log,
    emit(argument: string) {
      for (const callback of subscriptions) callback(argument);
    },
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("electronAcceleratorToGnomeBinding", () => {
  it.each([
    ["F8", "F8"],
    ["Control+Shift+F7", "<Control><Shift>F7"],
    ["CommandOrControl+Alt+a", "<Control><Alt>a"],
    ["Super+1", "<Super>1"],
    ["Ctrl+Enter", "<Control>Return"],
    ["Shift+PageUp", "<Shift>Page_Up"],
    ["Alt+Comma", "<Alt>comma"],
  ])("converts %s to %s", (accelerator, binding) => {
    expect(electronAcceleratorToGnomeBinding(accelerator)).toBe(binding);
  });

  it("rejects malformed accelerators", () => {
    expect(electronAcceleratorToGnomeBinding("Control+F25")).toBeNull();
    expect(electronAcceleratorToGnomeBinding("Control+UnsupportedKey")).toBeNull();
    expect(electronAcceleratorToGnomeBinding("Control+Bogus+F8")).toBeNull();
    expect(electronAcceleratorToGnomeBinding("Control++F8")).toBeNull();
  });
});

describe("isGnomeSession", () => {
  it.each([
    [{ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, true],
    [{ XDG_CURRENT_DESKTOP: "GNOME-Classic:GNOME" }, true],
    [{ DESKTOP_SESSION: "gnome" }, true],
    [{ XDG_CURRENT_DESKTOP: "KDE" }, false],
    [{ XDG_CURRENT_DESKTOP: "Hyprland" }, false],
    [{}, false],
  ])("detects %o as %s", (env, expected) => {
    expect(isGnomeSession(env)).toBe(expected);
  });
});

describe("settings value parsing", () => {
  it("parses gsettings string and list syntax", () => {
    expect(parseGsettingsString("'WFHelper (F8)'")).toBe("WFHelper (F8)");
    expect(parseGsettingsString("'a\\'b'")).toBe("a'b");
    expect(parseCustomKeybindings("@as []")).toEqual([]);
    expect(parseCustomKeybindings("['/a/', '/b/']")).toEqual(["/a/", "/b/"]);
  });
});

describe("GNOME native shortcut backend", () => {
  it("writes a custom keybinding and appends its path once", () => {
    const harness = createHarness();
    const callback = vi.fn();

    expect(harness.shortcut.register("F8", callback)).toBe(true);
    expect(harness.shortcut.register("F8", callback)).toBe(true);

    const path = `${ROOT}wfhelper_F8/`;
    expect(harness.store.list).toEqual([path]);
    expect(harness.store.entries.get(path)).toEqual({
      name: "WFHelper (F8)",
      command:
        "gdbus emit --session --object-path /org/wfhelper/Hotkeys --signal org.wfhelper.Hotkeys.Activated wfhelper_F8",
      binding: "F8",
    });
    expect(harness.bus.subscribe).toHaveBeenCalledWith(
      "org.wfhelper.Hotkeys",
      "Activated",
      "/org/wfhelper/Hotkeys",
      expect.any(Function),
    );
    expect(harness.fallback.register).not.toHaveBeenCalled();
  });

  it("dispatches the matching slot and de-duplicates rapid signals", () => {
    const harness = createHarness();
    const first = vi.fn();
    const second = vi.fn();
    harness.shortcut.register("F8", first);
    harness.shortcut.register("F7", second);

    harness.emit("wfhelper_F8");
    harness.emit("wfhelper_F8");
    harness.emit("wfhelper_unknown");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    harness.advance(151);
    harness.emit("wfhelper_F8");
    harness.emit("wfhelper_F7");

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stores equivalent accelerator spellings in one entry", () => {
    const harness = createHarness();
    const first = vi.fn();
    const second = vi.fn();
    harness.shortcut.register("Ctrl+F8", first);
    harness.shortcut.register("Control+F8", second);

    expect(harness.store.list).toEqual([`${ROOT}wfhelper_Control_F8/`]);

    harness.emit("wfhelper_Control_F8");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("removes the entry and resets its keys on unregister", () => {
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());

    harness.shortcut.unregister("F8");

    const path = `${ROOT}wfhelper_F8/`;
    expect(harness.store.list).toEqual([]);
    expect(harness.store.entries.get(path)).toEqual({});
    expect(harness.fallback.unregister).not.toHaveBeenCalled();
  });

  it("delegates unknown unregisters to the fallback", () => {
    const harness = createHarness();

    harness.shortcut.unregister("F9");

    expect(harness.fallback.unregister).toHaveBeenCalledWith("F9");
  });

  it("replaces the old entry when the accelerator changes", () => {
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.shortcut.unregister("F8");
    harness.shortcut.register("F10", vi.fn());

    expect(harness.store.list).toEqual([`${ROOT}wfhelper_F10/`]);
  });

  it("purges stale WFHelper entries but keeps the user's own shortcuts", () => {
    const userPath = `${ROOT}custom0/`;
    const stalePath = `${ROOT}wfhelper_F8/`;
    const harness = createHarness({
      list: [userPath, stalePath],
      entries: {
        [userPath]: { command: "/usr/bin/ringboard-iced toggle", binding: "<Super>v" },
        [stalePath]: { command: `gdbus emit ... ${SIGNAL_MARKER}.Activated wfhelper_F8` },
      },
    });

    harness.shortcut.register("F7", vi.fn());

    expect(harness.store.list).toEqual([userPath, `${ROOT}wfhelper_F7/`]);
    expect(harness.store.entries.get(userPath)?.binding).toBe("<Super>v");
  });

  it("falls back when the custom-keybinding schema is unavailable", () => {
    const fallback = { register: vi.fn(() => true), unregister: vi.fn() };
    const shortcut = createGnomeNativeShortcuts({
      log: { info: vi.fn(), warn: vi.fn() },
      fallback,
      exec: () => {
        throw new Error("gsettings: schema not found");
      },
      bus: { subscribe: vi.fn(), dispose: vi.fn() },
      hasGdbus: () => true,
    });

    expect(shortcut.register("F8", vi.fn())).toBe(true);
    expect(fallback.register).toHaveBeenCalledWith("F8", expect.any(Function));
  });

  it("falls back when gdbus is missing", () => {
    const fallback = { register: vi.fn(() => true), unregister: vi.fn() };
    const shortcut = createGnomeNativeShortcuts({
      log: { info: vi.fn(), warn: vi.fn() },
      fallback,
      exec: () => "",
      bus: { subscribe: vi.fn(), dispose: vi.fn() },
      hasGdbus: () => false,
    });

    expect(shortcut.register("F8", vi.fn())).toBe(true);
    expect(fallback.register).toHaveBeenCalledWith("F8", expect.any(Function));
  });

  it("falls back for an accelerator GNOME cannot represent", () => {
    const harness = createHarness();

    expect(harness.shortcut.register("Control+UnsupportedKey", vi.fn())).toBe(true);

    expect(harness.fallback.register).toHaveBeenCalledWith(
      "Control+UnsupportedKey",
      expect.any(Function),
    );
  });

  it("removes every entry and closes the bus on dispose", () => {
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.shortcut.register("F7", vi.fn());

    harness.shortcut.dispose();

    expect(harness.store.list).toEqual([]);
    expect(harness.bus.dispose).toHaveBeenCalledTimes(1);
    expect(harness.shortcut.register("F8", vi.fn())).toBe(false);
  });
});
