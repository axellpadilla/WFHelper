/** Bound to a compositor key where global hotkeys never fire (native Wayland). */
export const OVERLAY_INTERACTION_TOGGLE_ARG = "--toggle-overlay-interaction";
export const REWARD_SCAN_TRIGGER_ARG = "--trigger-reward-scan";
export const RIVEN_SCAN_TRIGGER_ARG = "--trigger-riven-scan";

const WARFRAME_AUTO_LAUNCH_ARG = "--warframe-auto-launch";

/** A toggle launch only hands its argv to the running instance and never starts the app. */
export function isOverlayToggleLaunch(argv: readonly string[]): boolean {
  return argv.includes(OVERLAY_INTERACTION_TOGGLE_ARG);
}

/** Any compositor shortcut action must hand off to the running instance only. */
export function isOverlayActionLaunch(argv: readonly string[]): boolean {
  return (
    isOverlayToggleLaunch(argv) ||
    argv.includes(REWARD_SCAN_TRIGGER_ARG) ||
    argv.includes(RIVEN_SCAN_TRIGGER_ARG)
  );
}

/** What this process does once it has asked for the single-instance lock. */
export function startupAction(
  argv: readonly string[],
  hasLock: boolean,
): "start" | "quit" | "exit-quietly" {
  if (isOverlayActionLaunch(argv)) return "exit-quietly";
  return hasLock ? "start" : "quit";
}

/** What the running instance does with the argv of a second launch. */
export function secondLaunchAction(
  argv: readonly string[],
):
  | "toggle-overlay-interaction"
  | "trigger-reward-scan"
  | "trigger-riven-scan"
  | "reveal"
  | "ignore" {
  if (argv.includes(OVERLAY_INTERACTION_TOGGLE_ARG)) return "toggle-overlay-interaction";
  if (argv.includes(REWARD_SCAN_TRIGGER_ARG)) return "trigger-reward-scan";
  if (argv.includes(RIVEN_SCAN_TRIGGER_ARG)) return "trigger-riven-scan";
  if (argv.includes(WARFRAME_AUTO_LAUNCH_ARG)) return "ignore";
  return "reveal";
}
