import { describe, expect, it } from "vitest";

import {
  isOverlayToggleLaunch,
  OVERLAY_INTERACTION_TOGGLE_ARG,
  REWARD_SCAN_TRIGGER_ARG,
  RIVEN_SCAN_TRIGGER_ARG,
  secondLaunchAction,
  startupAction,
} from "../../services/launchArgs";

const APP = "/opt/WFHelper.AppImage";

describe("launch arguments", () => {
  it("a toggle launch never starts the app, with or without a running instance", () => {
    const argv = [APP, OVERLAY_INTERACTION_TOGGLE_ARG];

    expect(isOverlayToggleLaunch(argv)).toBe(true);
    expect(startupAction(argv, false)).toBe("exit-quietly");
    expect(startupAction(argv, true)).toBe("exit-quietly");
  });

  it.each([
    [REWARD_SCAN_TRIGGER_ARG, "trigger-reward-scan"],
    [RIVEN_SCAN_TRIGGER_ARG, "trigger-riven-scan"],
  ] as const)("a %s launch exits quietly and routes to its action", (arg, action) => {
    const argv = [APP, "--no-sandbox", arg];

    expect(startupAction(argv, false)).toBe("exit-quietly");
    expect(startupAction(argv, true)).toBe("exit-quietly");
    expect(secondLaunchAction(argv)).toBe(action);
  });

  it("an ordinary launch starts with the lock and quits without it", () => {
    expect(isOverlayToggleLaunch([APP])).toBe(false);
    expect(startupAction([APP], true)).toBe("start");
    expect(startupAction([APP, "--warframe-auto-launch"], false)).toBe("quit");
  });

  it("the running instance toggles overlays for a toggle launch instead of revealing", () => {
    expect(secondLaunchAction([APP, "--no-sandbox", OVERLAY_INTERACTION_TOGGLE_ARG])).toBe(
      "toggle-overlay-interaction",
    );
    expect(secondLaunchAction([APP])).toBe("reveal");
    expect(secondLaunchAction([APP, "--warframe-auto-launch"])).toBe("ignore");
  });
});
