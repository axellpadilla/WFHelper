import { describe, expect, it, vi } from "vitest";

import {
  createHyprlandShortcut,
  electronAcceleratorToHyprland,
  hyprlandShortcutCommand,
  type HyprlandShortcutAction,
} from "../../services/hyprlandShortcut";

interface Binding {
  modmask: number;
  key: string;
  keycode?: number;
  description?: string;
  dispatcher?: string;
  arg?: string;
}

function createHarness(options: { socketExists?: boolean; initialBinds?: Binding[] } = {}) {
  const bindings = [...(options.initialBinds ?? [])];
  const calls: string[][] = [];
  const run = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === "-j" && args[1] === "binds") return JSON.stringify(bindings);
    if (args[0] !== "keyword") throw new Error(`unexpected command: ${args.join(" ")}`);
    if (args[1] === "bind") {
      const [modifiers, key, dispatcher, ...arg] = args[2].split(",");
      const modmask = modifiers
        .split(" ")
        .reduce(
          (mask, modifier) => mask | ({ CTRL: 4, ALT: 8, SHIFT: 1, SUPER: 64 }[modifier] ?? 0),
          0,
        );
      bindings.push({ modmask, key, dispatcher, arg: arg.join(",") });
      return "ok";
    }
    if (args[1] === "unbind") {
      const [modifiers, key] = args[2].split(",");
      const modmask = modifiers
        .split(" ")
        .reduce(
          (mask, modifier) => mask | ({ CTRL: 4, ALT: 8, SHIFT: 1, SUPER: 64 }[modifier] ?? 0),
          0,
        );
      for (const binding of [...bindings]) {
        if (binding.modmask === modmask && binding.key === key) {
          bindings.splice(bindings.indexOf(binding), 1);
        }
      }
      return "ok";
    }
    throw new Error(`unexpected keyword: ${args[1]}`);
  });
  const fallback = { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn() };
  const actions: Record<string, HyprlandShortcutAction> = {
    F8: "--trigger-reward-scan",
    "Control+Shift+F7": "--toggle-overlay-interaction",
    "Alt+F6": "--trigger-riven-scan",
  };
  const actionForAccelerator = (accelerator: string): HyprlandShortcutAction | null =>
    actions[accelerator] ?? null;
  const shortcut = createHyprlandShortcut({
    fallback,
    log,
    platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "hypr-test", XDG_RUNTIME_DIR: "/run/user/1000" },
    socketExists: () => options.socketExists ?? true,
    actionForAccelerator,
    commandForAction: (action) => `env WFHELPER_USER_DATA='/profile' '/app' '${action}'`,
    run,
  });

  return { shortcut, bindings, calls, fallback, log, run };
}

describe("Hyprland shortcut backend", () => {
  it.each([
    ["F8", { modifiers: "", modifierMask: 0, key: "F8", keycode: 74 }],
    [
      "CommandOrControl+Shift+F7",
      { modifiers: "CTRL SHIFT", modifierMask: 5, key: "F7", keycode: 73 },
    ],
    ["Alt+F6", { modifiers: "ALT", modifierMask: 8, key: "F6", keycode: 72 }],
  ])("converts Electron accelerator %s", (accelerator, expected) => {
    expect(electronAcceleratorToHyprland(accelerator)).toEqual(expected);
  });

  it("rejects accelerators it cannot safely translate", () => {
    expect(electronAcceleratorToHyprland("Control+F25")).toBeNull();
    expect(electronAcceleratorToHyprland("Control+UnsupportedKey")).toBeNull();
    expect(electronAcceleratorToHyprland("Control+Bogus+F8")).toBeNull();
  });

  it("quotes a single-instance AppImage command and preserves the sandbox option", () => {
    expect(
      hyprlandShortcutCommand({
        executable: "/usr/bin/wfhelper",
        appPath: "/unused",
        userData: "/profile dir",
        packaged: true,
        appImage: "/tmp/WF's.AppImage",
        launchArgs: ["--no-sandbox"],
        action: "--trigger-reward-scan",
      }),
    ).toBe(
      "env -u ELECTRON_RUN_AS_NODE 'WFHELPER_USER_DATA=/profile dir' '/tmp/WF'\\''s.AppImage' '--no-sandbox' '--trigger-reward-scan'",
    );
  });

  it("registers a temporary bind and removes it on unregister", () => {
    const harness = createHarness();
    const callback = vi.fn();

    expect(harness.shortcut.register("F8", callback)).toBe(true);
    expect(harness.bindings).toEqual([
      {
        modmask: 0,
        key: "F8",
        dispatcher: "exec",
        arg: "env WFHELPER_USER_DATA='/profile' '/app' '--trigger-reward-scan'",
      },
    ]);
    expect(harness.calls).toContainEqual([
      "keyword",
      "bind",
      ",F8,exec,env WFHELPER_USER_DATA='/profile' '/app' '--trigger-reward-scan'",
    ]);
    expect(harness.fallback.register).not.toHaveBeenCalled();

    harness.shortcut.unregister("F8");
    expect(harness.bindings).toEqual([]);
    expect(harness.calls).toContainEqual(["keyword", "unbind", ",F8"]);
  });

  it("uses Hyprland's Lua bind fallback when legacy keyword binds are disabled", () => {
    let bindings: Binding[] = [];
    const run = vi.fn((args: string[]) => {
      if (args[0] === "-j") return JSON.stringify(bindings);
      if (args[0] === "keyword") return "keyword can't work with non-legacy parsers. Use eval.";
      if (args[0] === "eval" && args[1].startsWith("hl.bind(")) {
        const key = /hl\.bind\("(?:[^"\\]|\\.)*?([^ +"]+)"/.exec(args[1])?.[1];
        const description = /description = "([^"]+)"/.exec(args[1])?.[1];
        expect(args[1]).toContain("hl.dsp.exec_cmd(");
        expect(args[1]).toContain("dont_inhibit = true");
        bindings = [{ modmask: 0, key: key ?? "", dispatcher: "__lua", description }];
        return "ok";
      }
      if (args[0] === "eval" && args[1] === 'hl.unbind("F8")') {
        bindings = [];
        return "ok";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const fallback = { register: vi.fn(() => true), unregister: vi.fn() };
    const shortcut = createHyprlandShortcut({
      fallback,
      log: { info: vi.fn(), warn: vi.fn() },
      platform: "linux",
      env: { HYPRLAND_INSTANCE_SIGNATURE: "hypr-test", XDG_RUNTIME_DIR: "/run/user/1000" },
      socketExists: () => true,
      actionForAccelerator: () => "--trigger-reward-scan",
      commandForAction: (action) => `/app ${action}`,
      run,
    });

    expect(shortcut.register("F8", vi.fn())).toBe(true);
    expect(bindings).toHaveLength(1);
    shortcut.dispose();
    expect(bindings).toEqual([]);
    expect(fallback.register).not.toHaveBeenCalled();
  });

  it("disposes every registered Hyprland binding", () => {
    const harness = createHarness();

    expect(harness.shortcut.register("F8", vi.fn())).toBe(true);
    expect(harness.shortcut.register("Control+Shift+F7", vi.fn())).toBe(true);
    expect(harness.shortcut.register("Alt+F6", vi.fn())).toBe(true);
    harness.shortcut.dispose();

    expect(harness.bindings).toEqual([]);
    expect(
      harness.calls.filter((args) => args[0] === "keyword" && args[1] === "unbind"),
    ).toHaveLength(3);
  });

  it("does not remove a user binding that replaced its temporary bind", () => {
    const harness = createHarness();
    harness.shortcut.register("F8", vi.fn());
    harness.bindings[0] = { modmask: 0, key: "F8", dispatcher: "exec", arg: "user command" };

    harness.shortcut.unregister("F8");

    expect(harness.bindings).toEqual([
      { modmask: 0, key: "F8", dispatcher: "exec", arg: "user command" },
    ]);
    expect(harness.calls.some((args) => args[0] === "keyword" && args[1] === "unbind")).toBe(false);
  });

  it("falls back to globalShortcut when the socket is missing or the key is unmapped", () => {
    const noSocket = createHarness({ socketExists: false });
    const callback = vi.fn();
    expect(noSocket.shortcut.register("F8", callback)).toBe(true);
    expect(noSocket.fallback.register).toHaveBeenCalledWith("F8", callback);
    noSocket.shortcut.unregister("F8");
    expect(noSocket.fallback.unregister).toHaveBeenCalledWith("F8");

    const unmapped = createHarness();
    const otherCallback = vi.fn();
    expect(unmapped.shortcut.register("F5", otherCallback)).toBe(true);
    expect(unmapped.fallback.register).toHaveBeenCalledWith("F5", otherCallback);
    expect(unmapped.bindings).toEqual([]);
  });

  it("uses globalShortcut rather than taking a key already owned by the compositor", () => {
    const harness = createHarness({
      initialBinds: [{ modmask: 0, key: "F8", dispatcher: "exec", arg: "user command" }],
    });
    const callback = vi.fn();

    expect(harness.shortcut.register("F8", callback)).toBe(true);
    expect(harness.fallback.register).toHaveBeenCalledWith("F8", callback);
    expect(harness.bindings).toEqual([
      { modmask: 0, key: "F8", dispatcher: "exec", arg: "user command" },
    ]);
  });
});
