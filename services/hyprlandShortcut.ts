import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  OVERLAY_INTERACTION_TOGGLE_ARG,
  REWARD_SCAN_TRIGGER_ARG,
  RIVEN_SCAN_TRIGGER_ARG,
} from "./launchArgs";

export type HyprlandShortcutAction =
  | typeof OVERLAY_INTERACTION_TOGGLE_ARG
  | typeof REWARD_SCAN_TRIGGER_ARG
  | typeof RIVEN_SCAN_TRIGGER_ARG;

interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface HyprlandKey {
  modifiers: string;
  modifierMask: number;
  key: string;
  keycode?: number;
}

interface HyprlandBinding {
  modmask?: number;
  key?: string;
  keycode?: number;
  description?: string;
  dispatcher?: string;
  arg?: string;
}

interface RegisteredShortcut {
  key: HyprlandKey;
  command?: string;
  description?: string;
  lua?: boolean;
  fallback: boolean;
}

const MODIFIERS: Record<string, [string, number]> = {
  ctrl: ["CTRL", 4],
  control: ["CTRL", 4],
  commandorcontrol: ["CTRL", 4],
  alt: ["ALT", 8],
  option: ["ALT", 8],
  shift: ["SHIFT", 1],
  super: ["SUPER", 64],
  meta: ["SUPER", 64],
  command: ["SUPER", 64],
};

const SPECIAL_KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

const MODIFIER_ORDER = ["CTRL", "ALT", "SHIFT", "SUPER"];

/** Convert Electron accelerator syntax into a Hyprland modifier/key pair. */
export function electronAcceleratorToHyprland(accelerator: string): HyprlandKey | null {
  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const rawKey = parts.pop()?.toLowerCase();
  if (!rawKey || parts.length !== accelerator.split("+").length - 1) return null;

  const modifiers = new Set<string>();
  let modifierMask = 0;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier[0]);
    modifierMask |= modifier[1];
  }

  const functionKey = /^f([1-9]|1\d|2[0-4])$/.exec(rawKey);
  const key = functionKey
    ? rawKey.toUpperCase()
    : (SPECIAL_KEYS[rawKey] ?? (/^[a-z0-9]$/.test(rawKey) ? rawKey : null));
  if (!key) return null;

  const functionNumber = functionKey ? Number(functionKey[1]) : 0;
  const keycode =
    functionNumber >= 1 && functionNumber <= 10
      ? 66 + functionNumber
      : functionNumber === 11
        ? 95
        : functionNumber === 12
          ? 96
          : undefined;

  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)).join(" "),
    modifierMask,
    key,
    ...(keycode === undefined ? {} : { keycode }),
  };
}

function shellQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid shortcut launch argument");
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function hyprlandShortcutCommand(options: {
  executable: string;
  appPath: string;
  userData: string;
  packaged: boolean;
  appImage?: string;
  launchArgs?: readonly string[];
  action: HyprlandShortcutAction;
}): string {
  const executable = options.appImage || options.executable;
  const args = [
    ...(options.packaged || options.appImage ? [] : [options.appPath]),
    ...(options.launchArgs ?? []),
  ];
  return [
    "env",
    "-u",
    "ELECTRON_RUN_AS_NODE",
    shellQuote(`WFHELPER_USER_DATA=${options.userData}`),
    ...[executable, ...args, options.action].map(shellQuote),
  ].join(" ");
}

function hyprlandSocketPath(env: NodeJS.ProcessEnv): string | null {
  if (!env.XDG_RUNTIME_DIR || !env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  return path.join(env.XDG_RUNTIME_DIR, "hypr", env.HYPRLAND_INSTANCE_SIGNATURE, ".socket.sock");
}

function keycodeForBinding(key: HyprlandKey, binding: HyprlandBinding): boolean {
  return (
    binding.modmask === key.modifierMask &&
    (binding.key?.toLowerCase() === key.key.toLowerCase() ||
      (key.keycode !== undefined && binding.keycode === key.keycode))
  );
}

function luaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function luaKey(key: HyprlandKey): string {
  return [...key.modifiers.split(" ").filter(Boolean), key.key].join(" + ");
}

/**
 * Registers mapped overlay hotkeys as runtime Hyprland binds. No compositor
 * configuration is written; each bind is removed when unregistered/disposed.
 */
export function createHyprlandShortcut(options: {
  fallback: ShortcutBackend;
  log: Logger;
  actionForAccelerator: (accelerator: string) => HyprlandShortcutAction | null;
  commandForAction: (action: HyprlandShortcutAction) => string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  socketExists?: (socketPath: string) => boolean;
  run?: (args: string[]) => string;
}): ShortcutBackend & { dispose(): void } {
  const env = options.env ?? process.env;
  const socketPath = hyprlandSocketPath(env);
  const native = (options.platform ?? process.platform) === "linux" && socketPath !== null;
  const socketExists = options.socketExists ?? fs.existsSync;
  const run =
    options.run ??
    ((args) => execFileSync("hyprctl", args, { encoding: "utf8", timeout: 1000, env }));
  const registered = new Map<string, RegisteredShortcut>();
  let useLua = false;

  function binds(): HyprlandBinding[] {
    const result: unknown = JSON.parse(run(["-j", "binds"]));
    if (!Array.isArray(result)) throw new Error("Invalid Hyprland bindings response");
    return result as HyprlandBinding[];
  }

  function change(legacyArgs: string[], luaCode: string): boolean {
    if (!useLua) {
      const response = run(["keyword", ...legacyArgs]).trim();
      if (/non-legacy parsers/.test(response)) useLua = true;
      else {
        if (response !== "ok") {
          throw new Error(response || "Hyprland rejected shortcut command");
        }
        return false;
      }
    }
    const response = run(["eval", luaCode]).trim();
    if (response !== "ok") throw new Error(response || "Hyprland rejected Lua shortcut command");
    return true;
  }

  function fallbackRegister(accelerator: string, callback: () => void): boolean {
    const ok = options.fallback.register(accelerator, callback);
    if (ok) {
      registered.set(accelerator, {
        key: { modifiers: "", modifierMask: 0, key: "" },
        fallback: true,
      });
    }
    return ok;
  }

  function unregister(accelerator: string): void {
    const entry = registered.get(accelerator);
    if (!entry) {
      options.fallback.unregister(accelerator);
      return;
    }
    registered.delete(accelerator);
    if (entry.fallback) {
      options.fallback.unregister(accelerator);
      return;
    }

    try {
      const stillOwned = binds().some(
        (binding) =>
          keycodeForBinding(entry.key, binding) &&
          (entry.lua
            ? binding.description === entry.description
            : binding.dispatcher === "exec" && binding.arg === entry.command),
      );
      if (stillOwned) {
        change(
          ["unbind", `${entry.key.modifiers},${entry.key.key}`],
          `hl.unbind(${luaQuote(luaKey(entry.key))})`,
        );
      }
    } catch (err) {
      options.log.warn("[HyprlandShortcut] unbind failed:", accelerator, String(err));
    }
  }

  return {
    register(accelerator, callback): boolean {
      if (registered.has(accelerator)) return false;
      if (!native || !socketPath || !socketExists(socketPath)) {
        return fallbackRegister(accelerator, callback);
      }

      const action = options.actionForAccelerator(accelerator);
      const key = action ? electronAcceleratorToHyprland(accelerator) : null;
      if (!action || !key) return fallbackRegister(accelerator, callback);

      let launchCommand: string;
      try {
        launchCommand = options.commandForAction(action);
        // A comma starts another field in Hyprland's keyword bind grammar. Keep
        // paths with commas safe by using Electron's shortcut backend instead.
        if (launchCommand.includes(",")) return fallbackRegister(accelerator, callback);
        const description = `WFHelper shortcut ${createHash("sha256")
          .update(launchCommand)
          .digest("hex")
          .slice(0, 12)}`;
        const existing = binds().filter((binding) => keycodeForBinding(key, binding));
        const owned = existing.find(
          (binding) =>
            binding.description === description ||
            (binding.dispatcher === "exec" && binding.arg === launchCommand),
        );
        if (owned) {
          registered.set(accelerator, {
            key,
            command: launchCommand,
            description,
            lua: bindingIsLua(owned),
            fallback: false,
          });
          return true;
        }
        if (existing.length > 0) {
          options.log.warn("[HyprlandShortcut] key already bound:", accelerator);
          return fallbackRegister(accelerator, callback);
        }
        const lua = change(
          ["bind", `${key.modifiers},${key.key},exec,${launchCommand}`],
          `hl.bind(${luaQuote(luaKey(key))}, hl.dsp.exec_cmd(${luaQuote(launchCommand)}), {dont_inhibit = true, description = ${luaQuote(description)}})`,
        );
        const installed = binds().some(
          (binding) =>
            keycodeForBinding(key, binding) &&
            (lua
              ? binding.description === description
              : binding.dispatcher === "exec" && binding.arg === launchCommand),
        );
        if (!installed) throw new Error("Hyprland did not install the requested bind");
        registered.set(accelerator, {
          key,
          command: launchCommand,
          description,
          lua,
          fallback: false,
        });
        options.log.info("[HyprlandShortcut] registered:", accelerator, action);
        return true;
      } catch (err) {
        options.log.warn("[HyprlandShortcut] registration failed:", accelerator, String(err));
        return fallbackRegister(accelerator, callback);
      }
    },
    unregister,
    dispose(): void {
      for (const accelerator of [...registered.keys()]) unregister(accelerator);
    },
  };
}

function bindingIsLua(binding: HyprlandBinding): boolean {
  return binding.dispatcher === "__lua";
}
