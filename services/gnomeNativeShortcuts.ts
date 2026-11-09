import { execFileSync } from "node:child_process";

import { createGlibSessionBus, type GlibSessionBus } from "./glibSessionBus";

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** GNOME's keyboard settings expose user shortcuts through this relocatable
 *  schema. Entries live in the array key below and each path holds
 *  `name`/`command`/`binding`. */
const MEDIA_KEYS_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_KEYBINDING_SCHEMA = `${MEDIA_KEYS_SCHEMA}.custom-keybinding`;
const CUSTOM_KEYBINDINGS_KEY = "custom-keybindings";
const CUSTOM_KEYBINDINGS_ROOT = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";

const SIGNAL_INTERFACE = "org.wfhelper.Hotkeys";
const SIGNAL_MEMBER = "Activated";
const SIGNAL_PATH = "/org/wfhelper/Hotkeys";

const MODIFIERS: Record<string, string> = {
  ctrl: "<Control>",
  control: "<Control>",
  commandorcontrol: "<Control>",
  alt: "<Alt>",
  option: "<Alt>",
  shift: "<Shift>",
  logo: "<Super>",
  meta: "<Super>",
  super: "<Super>",
  command: "<Super>",
};

const SPECIAL_KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  tab: "Tab",
  backspace: "BackSpace",
  insert: "Insert",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  comma: "comma",
  period: "period",
  minus: "minus",
  equal: "equal",
};

const MODIFIER_ORDER = ["<Control>", "<Alt>", "<Shift>", "<Super>"];
const DEDUPLICATION_WINDOW_MS = 150;

/** GNOME is the desktop the custom-keybinding schema belongs to. */
export function isGnomeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const desktops = [env.XDG_CURRENT_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .split(":")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return desktops.some((value) => value === "gnome" || value.startsWith("gnome-"));
}

/** Convert an Electron accelerator to the GTK syntax GNOME stores. */
export function electronAcceleratorToGnomeBinding(accelerator: string): string | null {
  const parts = accelerator.split("+");
  if (parts.some((part) => !part.trim())) return null;
  const rawKey = parts.pop()?.trim();
  if (!rawKey) return null;

  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS[part.trim().toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }

  const lowerKey = rawKey.toLowerCase();
  const functionKey = /^f([1-9]|1\d|2[0-4])$/.exec(lowerKey);
  const key = functionKey
    ? lowerKey.toUpperCase()
    : (SPECIAL_KEYS[lowerKey] ?? (/^[a-z0-9]$/.test(lowerKey) ? lowerKey : null));
  if (!key) return null;

  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("");
}

/** Stable across launches so a stale entry can be recognised and replaced.
 *
 *  Deriving the slot from the canonical GNOME binding keeps `Ctrl+F8` and
 *  `Control+F8` on the same entry instead of leaving one of them orphaned. */
export function gnomeShortcutSlot(accelerator: string): string {
  const canonical = (electronAcceleratorToGnomeBinding(accelerator) ?? accelerator)
    .replace(/[<>]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `wfhelper_${canonical || "shortcut"}`;
}

/** gsd runs this with `g_spawn_command_line_async`; every token is safe. */
export function gnomeShortcutCommand(slot: string): string {
  return `gdbus emit --session --object-path ${SIGNAL_PATH} --signal ${SIGNAL_INTERFACE}.${SIGNAL_MEMBER} ${slot}`;
}

function unescapeGvariant(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

export function parseGsettingsString(value: string): string {
  const text = value.trim();
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(text);
  if (quoted) return unescapeGvariant(quoted[1]);
  return text;
}

export function parseCustomKeybindings(value: string): string[] {
  const paths: string[] = [];
  const quoted = /'((?:[^'\\]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(value))) paths.push(unescapeGvariant(match[1]));
  return paths;
}

function quoteGvariantString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function formatCustomKeybindings(paths: readonly string[]): string {
  return `[${paths.map(quoteGvariantString).join(", ")}]`;
}

function entrySchema(path: string): string {
  return `${CUSTOM_KEYBINDING_SCHEMA}:${path}`;
}

export type GsettingsExec = (args: string[]) => string;

/** The AppImage prepends its mount to GLib's schema/library paths. A system
 *  `gsettings` inheriting those can miss the desktop schemas or load the
 *  bundle's libraries, so spawn it with the AppImage overrides removed. */
function systemChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.GSETTINGS_SCHEMA_DIR;
  delete env.GIO_MODULE_DIR;
  delete env.GI_TYPELIB_PATH;
  return env;
}

function defaultExec(args: string[]): string {
  return execFileSync("gsettings", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: systemChildEnv(),
  }).trim();
}

export interface GnomeNativeShortcutsOptions {
  log: Logger;
  fallback: ShortcutBackend;
  exec?: GsettingsExec;
  bus?: GlibSessionBus;
  now?: () => number;
  /** `gdbus` runs the activation command; without it the entry is inert. */
  hasGdbus?: () => boolean;
}

function defaultHasGdbus(): boolean {
  try {
    // gdbus has no --version flag; `help` exits 0 and needs no bus.
    execFileSync("gdbus", ["help"], { stdio: "ignore", env: systemChildEnv() });
    return true;
  } catch {
    return false;
  }
}

interface RegisteredShortcut {
  callback: () => void;
  path: string;
  lastFiredAt: number;
}

/** Global hotkeys through GNOME's own keyboard settings.
 *
 *  A portal session asks for approval every time GNOME creates it, and GNOME
 *  creates a new session for every app process. Native custom keybindings are
 *  grabbed by gnome-settings-daemon without any dialog, survive app restarts,
 *  and appear in Settings > Keyboard > Custom Shortcuts where the user can
 *  inspect or remove them. The command only emits a D-Bus signal, so a keypress
 *  costs a `gdbus` exec (~10 ms) instead of an Electron launch (~700 ms). */
export function createGnomeNativeShortcuts(
  options: GnomeNativeShortcutsOptions,
): ShortcutBackend & { dispose(): void } {
  const exec = options.exec ?? defaultExec;
  const hasGdbus = options.hasGdbus ?? defaultHasGdbus;
  const now = options.now ?? Date.now;
  const registered = new Map<string, RegisteredShortcut>();
  let available: boolean | null = null;
  let bus: GlibSessionBus | null = options.bus ?? null;
  let busSubscribed = false;
  let disposed = false;

  function getText(schema: string, key: string): string {
    return parseGsettingsString(exec(["get", schema, key]));
  }

  function setText(schema: string, key: string, value: string): void {
    exec(["set", schema, key, quoteGvariantString(value)]);
  }

  function setRaw(schema: string, key: string, value: string): void {
    exec(["set", schema, key, value]);
  }

  function readPaths(): string[] {
    return parseCustomKeybindings(getText(MEDIA_KEYS_SCHEMA, CUSTOM_KEYBINDINGS_KEY));
  }

  function writePaths(paths: readonly string[]): void {
    setRaw(MEDIA_KEYS_SCHEMA, CUSTOM_KEYBINDINGS_KEY, formatCustomKeybindings(paths));
  }

  function addPath(path: string): void {
    const paths = readPaths();
    if (!paths.includes(path)) writePaths([...paths, path]);
  }

  function removePath(path: string): void {
    const paths = readPaths();
    if (paths.includes(path)) writePaths(paths.filter((candidate) => candidate !== path));
  }

  function resetEntry(path: string): void {
    for (const key of ["name", "command", "binding"]) {
      exec(["reset", entrySchema(path), key]);
    }
  }

  /** Entries only carry a signal call; anything else is the user's own. */
  function purgeStaleEntries(): void {
    const paths = readPaths();
    const kept = paths.filter((path) => {
      if (!path.startsWith(CUSTOM_KEYBINDINGS_ROOT)) return true;
      try {
        return !getText(entrySchema(path), "command").includes(SIGNAL_INTERFACE);
      } catch {
        return true;
      }
    });
    if (kept.length === paths.length) return;
    writePaths(kept);
    options.log.info(
      "[GnomeShortcuts] removed",
      paths.length - kept.length,
      "stale WFHelper shortcut(s)",
    );
  }

  function ensureInitialized(): boolean {
    if (available !== null) return available;
    try {
      if (!hasGdbus()) throw new Error("gdbus is not available");
      exec(["list-keys", CUSTOM_KEYBINDING_SCHEMA]);
      purgeStaleEntries();
      available = true;
    } catch (err) {
      available = false;
      options.log.warn("[GnomeShortcuts] native custom shortcuts unavailable:", errorText(err));
    }
    return available;
  }

  function dispatch(slot: string): void {
    const entry = registered.get(slot);
    if (!entry) return;
    const timestamp = now();
    if (timestamp - entry.lastFiredAt < DEDUPLICATION_WINDOW_MS) return;
    entry.lastFiredAt = timestamp;
    try {
      entry.callback();
    } catch (err) {
      options.log.warn("[GnomeShortcuts] shortcut callback failed:", errorText(err));
    }
  }

  function subscribeIfNeeded(): void {
    if (busSubscribed) return;
    bus ??= createGlibSessionBus(options.log);
    bus.subscribe(SIGNAL_INTERFACE, SIGNAL_MEMBER, SIGNAL_PATH, dispatch);
    busSubscribed = true;
  }

  function removeEntry(shortcut: RegisteredShortcut): void {
    try {
      removePath(shortcut.path);
    } catch (err) {
      options.log.warn("[GnomeShortcuts] shortcut path removal failed:", errorText(err));
    }
    try {
      resetEntry(shortcut.path);
    } catch (err) {
      options.log.warn("[GnomeShortcuts] shortcut reset failed:", errorText(err));
    }
  }

  return {
    register(accelerator, callback): boolean {
      if (disposed) return false;
      if (!ensureInitialized()) return options.fallback.register(accelerator, callback);

      const binding = electronAcceleratorToGnomeBinding(accelerator);
      if (!binding) return options.fallback.register(accelerator, callback);

      const slot = gnomeShortcutSlot(accelerator);
      const existing = registered.get(slot);
      if (existing) {
        existing.callback = callback;
        return true;
      }

      const path = `${CUSTOM_KEYBINDINGS_ROOT}${slot}/`;
      try {
        subscribeIfNeeded();
        setText(entrySchema(path), "name", `WFHelper (${accelerator})`);
        setText(entrySchema(path), "command", gnomeShortcutCommand(slot));
        setText(entrySchema(path), "binding", binding);
        addPath(path);
      } catch (err) {
        options.log.warn("[GnomeShortcuts] register failed:", accelerator, errorText(err));
        try {
          removePath(path);
          resetEntry(path);
        } catch {
          // Best effort: a leftover path is inert once it leaves the array.
        }
        return options.fallback.register(accelerator, callback);
      }

      registered.set(slot, {
        callback,
        path,
        lastFiredAt: Number.NEGATIVE_INFINITY,
      });
      options.log.info("[GnomeShortcuts] registered:", accelerator, "as", binding);
      return true;
    },
    unregister(accelerator): void {
      const slot = gnomeShortcutSlot(accelerator);
      const shortcut = registered.get(slot);
      if (!shortcut) {
        options.fallback.unregister(accelerator);
        return;
      }
      registered.delete(slot);
      try {
        removeEntry(shortcut);
      } catch (err) {
        options.log.warn("[GnomeShortcuts] unregister failed:", accelerator, errorText(err));
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const shortcut of [...registered.values()]) {
        try {
          removeEntry(shortcut);
        } catch (err) {
          options.log.warn("[GnomeShortcuts] dispose cleanup failed:", errorText(err));
        }
      }
      registered.clear();
      try {
        bus?.dispose();
      } catch (err) {
        options.log.warn("[GnomeShortcuts] bus dispose failed:", errorText(err));
      }
      bus = null;
      busSubscribed = false;
    },
  };
}
