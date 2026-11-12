import { writable } from "svelte/store";
import { readStorage } from "../lib/persistence.js";
import type { MessageKey } from "../lib/i18n.js";
import type { ViewName } from "../types/views.js";

// The v2 key reruns setup after the 0.2.0 overhaul. Bump only when a future
// overhaul must rerun it again.
export const SETUP_COMPLETED_KEY = "setup-completed-v2";

// The main process seeds the gate through the window URL: renderer storage lost the
// v2 key on a profile that had completed setup, so it cannot be the source of truth.
const SETUP_QUERY_KEY = "setup";

function seededSetupCompleted(): boolean {
  try {
    return new URLSearchParams(location.search).get(SETUP_QUERY_KEY) === "1";
  } catch {
    return false;
  }
}

/** True once setup is complete in main-process state, or (for profiles that
 *  completed on a build before that state existed) in the renderer's v2 key. */
export function isSetupCompleted(): boolean {
  return seededSetupCompleted() || readStorage(SETUP_COMPLETED_KEY) === "1";
}

function getInitialView(): ViewName {
  return isSetupCompleted() ? "inventory" : "setup";
}

export const currentView = writable<ViewName>(getInitialView());

type StatusMessage = {
  key: MessageKey;
  params?: Record<string, string | number>;
};

export const statusText = writable<StatusMessage | null>({ key: "app.noInventoryLoaded" });
