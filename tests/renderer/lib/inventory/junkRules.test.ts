import { describe, expect, it } from "vitest";

import {
  annotateJunkRows,
  junkFields,
  type JunkItem,
} from "../../../../src/lib/inventory/junkRules.js";
import {
  buildSafetyContext,
  type InventorySafetySettings,
  type SafetyContext,
} from "../../../../src/lib/inventory/safetyRules.js";
import type { ItemDbEntry } from "../../../../src/types/inventory.js";

const MOD = "/Lotus/Upgrades/Mods/Serration";
const MOD_TRADEABLE = "/Lotus/Upgrades/Mods/Vitality";
const WEAPON = "/Lotus/Weapons/Tenno/Rifle/Braton";
const INGREDIENT = "/Lotus/Weapons/Tenno/Melee/BrokenWar";
const PRODUCT = "/Lotus/Weapons/Tenno/Melee/War";
const FRAME = "/Lotus/Powersuits/Volt/VoltPrime";
const PART = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeChassisComponent";
const OTHER_PART = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeNeuropticsComponent";

const DB: Record<string, ItemDbEntry> = {
  [MOD]: { name: "Serration", category: "Mods", tradable: false },
  [MOD_TRADEABLE]: { name: "Vitality", category: "Mods", tradable: true },
  [WEAPON]: { name: "Braton", masterable: true, tradable: false },
  [INGREDIENT]: { name: "Broken War", masterable: true, tradable: false },
  [PRODUCT]: {
    name: "War",
    masterable: true,
    recipe: {
      buildPrice: 0,
      buildTime: 0,
      num: 1,
      ingredients: [{ uniqueName: INGREDIENT, count: 1 }],
    },
  },
  [FRAME]: {
    name: "Volt Prime",
    masterable: true,
    components: [
      { name: "Chassis", uniqueName: PART, itemCount: 1 },
      { name: "Neuroptics", uniqueName: OTHER_PART, itemCount: 1 },
    ],
  },
  [PART]: { name: "Volt Prime Chassis", isBuildComponent: true, componentOf: FRAME },
  [OTHER_PART]: { name: "Volt Prime Neuroptics", isBuildComponent: true, componentOf: FRAME },
};

const MASTERED = new Set([FRAME, PRODUCT, WEAPON]);

function context(overrides: Partial<Parameters<typeof buildSafetyContext>[0]> = {}): SafetyContext {
  return buildSafetyContext({
    itemDb: DB,
    masteredUniqueNames: new Set<string>(),
    pinnedRequirements: new Map<string, number>(),
    ...overrides,
  });
}

function settings(overrides: Partial<InventorySafetySettings> = {}): InventorySafetySettings {
  return {
    spareDefault: 0,
    spares: {},
    locks: [],
    setKeep: [],
    ...overrides,
  };
}

function mod(overrides: Partial<JunkItem> = {}): JunkItem {
  return {
    internalName: MOD,
    name: "Serration",
    inventoryGroup: "mods",
    rank: 0,
    maxRank: 10,
    amount: 3,
    tradable: false,
    ...overrides,
  };
}

function weapon(overrides: Partial<JunkItem> = {}): JunkItem {
  return {
    internalName: WEAPON,
    name: "Braton",
    inventoryGroup: "equipment",
    rank: 30,
    maxRank: 30,
    amount: 1,
    tradable: false,
    ...overrides,
  };
}

function part(overrides: Partial<JunkItem> = {}): JunkItem {
  return {
    internalName: PART,
    name: "Volt Prime Chassis",
    inventoryGroup: "all_parts",
    amount: 1,
    tradable: true,
    ...overrides,
  };
}

describe("junkFields for mods", () => {
  it("treats unranked untradeable duplicates as chaff", () => {
    expect(junkFields(mod(), context())).toMatchObject({
      junk: true,
      junkBuildLater: false,
      junkRank: 3,
      junkCopies: 2,
    });
  });

  it("keeps the last copy", () => {
    expect(junkFields(mod({ amount: 1 }), context())).toMatchObject({
      junk: false,
      junkCopies: 0,
    });
  });

  it("never suggests a ranked copy", () => {
    expect(junkFields(mod({ rank: 5 }), context()).junk).toBe(false);
  });

  it("separates cheap duplicates from valuable ones", () => {
    const cheap = junkFields(
      mod({ internalName: MOD_TRADEABLE, tradable: true, platinum: 5 }),
      context(),
    );
    const valuable = junkFields(
      mod({ internalName: MOD_TRADEABLE, tradable: true, platinum: 80 }),
      context(),
    );
    expect(cheap).toMatchObject({ junk: true, junkRank: 2, junkCopies: 2 });
    expect(valuable).toMatchObject({ junk: false, junkRank: 1, junkCopies: 2 });
  });

  it("honours a per-item spare override", () => {
    expect(
      junkFields(mod(), context({ settings: settings({ spares: { [MOD]: 2 } }) })).junkCopies,
    ).toBe(1);
  });

  it("keeps locked, favorited, equipped and already-listed copies", () => {
    const locked = context({ settings: settings({ locks: [MOD] }) });
    expect(junkFields(mod(), locked).junk).toBe(false);
    expect(junkFields(mod({ favorite: true }), context()).junk).toBe(false);
    expect(junkFields(mod({ equipped: true }), context()).junk).toBe(false);
    expect(junkFields(mod({ orderPlaced: true }), context()).junk).toBe(false);
  });

  it("marks a pinned goal as build-later when nothing is spare", () => {
    const pinned = context({ pinnedRequirements: new Map([[MOD, 3]]) });
    expect(junkFields(mod(), pinned)).toMatchObject({
      junk: false,
      junkBuildLater: true,
      junkCopies: 0,
    });
  });
});

describe("junkFields for equipment", () => {
  it("does not suggest unmastered gear", () => {
    expect(junkFields(weapon({ rank: 0 }), context()).junk).toBe(false);
  });

  it("ranks mastered untradeable gear as chaff", () => {
    expect(junkFields(weapon(), context())).toMatchObject({
      junk: true,
      junkRank: 3,
      junkCopies: 1,
    });
  });

  it("separates cheap tradable gear from valuable gear", () => {
    expect(junkFields(weapon({ tradable: true, platinum: 8 }), context())).toMatchObject({
      junk: true,
      junkRank: 2,
    });
    expect(junkFields(weapon({ tradable: true, platinum: 200 }), context())).toMatchObject({
      junk: false,
      junkRank: 1,
    });
  });

  it("keeps the only copy of an ingredient for an unmastered build", () => {
    expect(
      junkFields(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false }),
        context(),
      ),
    ).toMatchObject({ junk: false, junkBuildLater: true, junkCopies: 0 });
  });

  it("allows selling duplicate ingredients beyond the copy the build needs", () => {
    expect(
      junkFields(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false, amount: 2 }),
        context(),
      ),
    ).toMatchObject({ junk: true, junkCopies: 1 });
  });

  it("releases the ingredient once the product is mastered", () => {
    expect(
      junkFields(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false }),
        context({ masteredUniqueNames: MASTERED }),
      ),
    ).toMatchObject({ junk: true, junkCopies: 1 });
  });
});

describe("junkFields for prime parts", () => {
  it("ranks spare parts by ducats per platinum", () => {
    expect(junkFields(part({ amount: 3, platinum: 5, ducatonator: 3 }), context())).toMatchObject({
      junk: true,
      junkBuildLater: false,
      junkRank: 3,
      junkCopies: 2,
    });
  });

  it("keeps the only copy a future build still needs", () => {
    expect(junkFields(part({ amount: 1, platinum: 5, ducatonator: 3 }), context())).toMatchObject({
      junk: false,
      junkBuildLater: true,
      junkCopies: 0,
    });
  });

  it("lets go of spares beyond what the future build needs", () => {
    expect(junkFields(part({ amount: 3, platinum: 5, ducatonator: 3 }), context()).junkCopies).toBe(
      2,
    );
  });

  it("does not call an expensive part junk, even when it is spare", () => {
    expect(
      junkFields(
        part({ amount: 2, platinum: 100, ducatonator: 0.15 }),
        context({ masteredUniqueNames: MASTERED }),
      ),
    ).toMatchObject({ junk: false, junkRank: 0.15, junkCopies: 2 });
  });

  it("still favours a part whose ducats beat its platinum", () => {
    expect(
      junkFields(
        part({ amount: 2, platinum: 20, ducatonator: 2.25 }),
        context({ masteredUniqueNames: MASTERED }),
      ),
    ).toMatchObject({ junk: true, junkRank: 2.25, junkCopies: 2 });
  });

  it("excludes a part already listed on the market", () => {
    expect(junkFields(part({ amount: 3, orderPlaced: true }), context()).junk).toBe(false);
  });

  it("keeps copies a pin claims", () => {
    expect(
      junkFields(
        part({ amount: 2, platinum: 5, ducatonator: 3 }),
        context({ pinnedRequirements: new Map([[PART, 1]]) }),
      ).junkCopies,
    ).toBe(1);
  });
});

describe("annotateJunkRows", () => {
  it("reuses a row whose junk values did not change", () => {
    const row = {
      ...mod(),
      junk: true,
      junkBuildLater: false,
      junkRank: 3,
      junkTie: null,
      junkCopies: 2,
    };
    const [annotated] = annotateJunkRows([row], context());
    expect(annotated).toBe(row);
  });

  it("annotates a fresh row", () => {
    const [annotated] = annotateJunkRows([mod()], context());
    expect(annotated).toMatchObject({ junk: true, junkRank: 3, junkCopies: 2 });
  });
});
