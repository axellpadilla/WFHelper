import { app, globalShortcut } from "electron";

import ctx from "./context";
import {
  createHyprlandShortcut,
  hyprlandShortcutCommand,
  type HyprlandShortcutAction,
} from "../services/hyprlandShortcut";
import {
  OVERLAY_INTERACTION_TOGGLE_ARG,
  REWARD_SCAN_TRIGGER_ARG,
  RIVEN_SCAN_TRIGGER_ARG,
} from "../services/launchArgs";
import { createKeyHookShortcut } from "../services/keyHookShortcut";
import { withScope } from "../services/logger";
import { createGnomeNativeShortcuts, isGnomeSession } from "../services/gnomeNativeShortcuts";
import { createXdgGlobalShortcutsPortal } from "../services/xdgGlobalShortcutsPortal";

const log = withScope("hotkeyRegistry");

const WAYLAND_SESSION = Boolean(
  process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland",
);

export const overlayHotkeyBackend =
  process.env.WFHELPER_DISABLE_KEYBOARD_HOOK === "1"
    ? { register: () => false, unregister: () => {}, dispose: () => {} }
    : process.platform === "win32"
      ? createKeyHookShortcut({ log })
      : process.platform === "linux" && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE)
        ? createHyprlandShortcut({
            fallback: globalShortcut,
            log,
            actionForAccelerator(accelerator) {
              if (accelerator === String(ctx.overlaySettings.hotkey || "")) {
                return REWARD_SCAN_TRIGGER_ARG;
              }
              if (accelerator === String(ctx.overlaySettings.interactionHotkey || "")) {
                return OVERLAY_INTERACTION_TOGGLE_ARG;
              }
              if (accelerator === String(ctx.overlaySettings.rivenRescanHotkey || "")) {
                return RIVEN_SCAN_TRIGGER_ARG;
              }
              return null;
            },
            commandForAction(action: HyprlandShortcutAction) {
              return hyprlandShortcutCommand({
                executable: process.execPath,
                appPath: app.getAppPath(),
                userData: app.getPath("userData"),
                packaged: app.isPackaged,
                appImage: process.env.APPIMAGE,
                launchArgs: process.argv.filter((arg) => arg === "--no-sandbox"),
                action,
              });
            },
          })
        : process.platform === "linux" && WAYLAND_SESSION && isGnomeSession(process.env)
          ? // GNOME shows the portal's approval dialog for every new session, and
            // a new app process is always a new session. Native custom shortcuts
            // have no dialog and survive restarts.
            createGnomeNativeShortcuts({ fallback: globalShortcut, log })
          : process.platform === "linux" && WAYLAND_SESSION
            ? createXdgGlobalShortcutsPortal({ fallback: globalShortcut, log })
            : globalShortcut;

export function disposeAppHotkeys(): void {
  if ("dispose" in overlayHotkeyBackend) overlayHotkeyBackend.dispose();
}

export function registerTransientHotkey(accelerator: string, callback: () => void): boolean {
  if (!accelerator) return false;
  if (
    accelerator === ctx.overlayHotkeyRegistered ||
    accelerator === ctx.overlayInteractionHotkeyRegistered ||
    accelerator === ctx.rivenRescanHotkeyRegistered
  ) {
    log.warn("[TransientHotkey] refusing overlay-owned accelerator:", accelerator);
    return false;
  }
  try {
    return overlayHotkeyBackend.register(accelerator, callback);
  } catch (err) {
    log.warn("[TransientHotkey] register failed:", accelerator, String(err));
    return false;
  }
}

export function unregisterTransientHotkey(accelerator: string): void {
  if (!accelerator) return;
  if (
    accelerator === ctx.overlayHotkeyRegistered ||
    accelerator === ctx.overlayInteractionHotkeyRegistered ||
    accelerator === ctx.rivenRescanHotkeyRegistered
  ) {
    return;
  }
  try {
    overlayHotkeyBackend.unregister(accelerator);
  } catch (err) {
    log.warn("[TransientHotkey] unregister failed:", accelerator, String(err));
  }
}
