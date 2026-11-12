import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isSetupCompleted, markSetupCompleted, setupStatePath } from "../../services/setupState";

function userDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-setup-"));
}

describe("setup state", () => {
  it("treats a profile without a state file as not completed", () => {
    expect(isSetupCompleted(userDataDir())).toBe(false);
  });

  it("persists completion so the next launch can skip the wizard", () => {
    const dir = userDataDir();
    expect(markSetupCompleted(dir)).toBe(true);
    expect(isSetupCompleted(dir)).toBe(true);
  });

  it("writes the file atomically next to the other userData files", () => {
    const dir = userDataDir();
    markSetupCompleted(dir);
    const file = setupStatePath(dir);
    expect(path.dirname(file)).toBe(dir);
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("survives a corrupt or foreign state file as not completed", () => {
    const dir = userDataDir();
    for (const body of ["", "{", "null", "[]", '{"completed":"yes"}', '{"completed":false}']) {
      fs.writeFileSync(setupStatePath(dir), body);
      expect(isSetupCompleted(dir)).toBe(false);
    }
  });

  it("reports a write failure instead of claiming completion", () => {
    const dir = userDataDir();
    const blocked = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocked, "");
    expect(markSetupCompleted(blocked)).toBe(false);
    expect(isSetupCompleted(blocked)).toBe(false);
  });
});
