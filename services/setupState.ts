import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "./atomicFile";

// Renderer storage proved unable to remember the one-time setup gate: the key was
// absent on a profile that had completed setup, so the wizard showed on every
// launch. Completion is app state, so it belongs next to the other userData files.
const SETUP_STATE_FILE_NAME = "setup-state.json";

type SetupState = {
  completed: true;
  completedAt: string;
};

export function setupStatePath(userDataDir: string): string {
  return path.join(userDataDir, SETUP_STATE_FILE_NAME);
}

/** A missing, unreadable, or half-written file means "not completed": the gate can
 *  only ever be skipped by a state file that says so. */
export function isSetupCompleted(userDataDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(setupStatePath(userDataDir), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { completed?: unknown }).completed === true
    );
  } catch {
    return false;
  }
}

export function markSetupCompleted(userDataDir: string): boolean {
  const state: SetupState = { completed: true, completedAt: new Date().toISOString() };
  try {
    writeFileAtomicSync(setupStatePath(userDataDir), `${JSON.stringify(state)}\n`);
    return true;
  } catch {
    return false;
  }
}
