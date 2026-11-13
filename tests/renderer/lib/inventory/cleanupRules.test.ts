import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLEANUP_MAX_UNIT_VALUE,
  annotateCleanupRows,
  cleanupFields,
  cleanupVerdict,
  partCleanupFields,
  type CleanupItem,
} from "../../../../src/lib/inventory/cleanupRules.js";
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
};

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

function mod(overrides: Partial<CleanupItem> = {}): CleanupItem {
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

function weapon(overrides: Partial<CleanupItem> = {}): CleanupItem {
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

describe("cleanupVerdict for mods", () => {
  it("treats unranked untradeable duplicates as chaff", () => {
    expect(cleanupVerdict(mod(), context())).toEqual({
      tier: 3,
      disposableCopies: 2,
      unitValue: null,
    });
  });

  it("keeps the last copy of a mod", () => {
    expect(cleanupVerdict(mod({ amount: 1 }), context())).toEqual({
      tier: 0,
      disposableCopies: 0,
      unitValue: null,
    });
  });

  it("never suggests a ranked copy, even with duplicates", () => {
    expect(cleanupVerdict(mod({ rank: 5 }), context()).tier).toBe(0);
  });

  it("tiers a cheap tradable duplicate below an expensive one", () => {
    const cheap = cleanupVerdict(
      mod({ internalName: MOD_TRADEABLE, tradable: true, platinum: 5 }),
      context(),
    );
    const valuable = cleanupVerdict(
      mod({ internalName: MOD_TRADEABLE, tradable: true, platinum: 80 }),
      context(),
    );
    expect(cheap).toMatchObject({ tier: 2, unitValue: 5, disposableCopies: 2 });
    expect(valuable).toMatchObject({ tier: 1, unitValue: 80, disposableCopies: 2 });
  });

  it("honours a per-item spare override", () => {
    expect(
      cleanupVerdict(mod(), context({ settings: settings({ spares: { [MOD]: 2 } }) }))
        .disposableCopies,
    ).toBe(1);
  });

  it("keeps locked, favorited and equipped copies", () => {
    const locked = context({ settings: settings({ locks: [MOD] }) });
    expect(cleanupVerdict(mod(), locked).tier).toBe(0);
    expect(cleanupVerdict(mod({ favorite: true }), context()).tier).toBe(0);
    expect(cleanupVerdict(mod({ equipped: true }), context()).tier).toBe(0);
  });

  it("keeps copies a pinned goal still needs", () => {
    const pinned = context({ pinnedRequirements: new Map([[MOD, 3]]) });
    expect(cleanupVerdict(mod(), pinned).disposableCopies).toBe(0);
  });
});

describe("cleanupVerdict for equipment", () => {
  it("does not suggest unmastered gear", () => {
    expect(cleanupVerdict(weapon({ rank: 0 }), context()).tier).toBe(0);
  });

  it("ranks mastered untradeable gear as chaff", () => {
    expect(cleanupVerdict(weapon(), context())).toMatchObject({
      tier: 3,
      disposableCopies: 1,
      unitValue: null,
    });
  });

  it("tiers a cheap tradable weapon as cheap and a valuable one as keep-worthy", () => {
    expect(cleanupVerdict(weapon({ tradable: true, platinum: 8 }), context()).tier).toBe(2);
    expect(cleanupVerdict(weapon({ tradable: true, platinum: 200 }), context()).tier).toBe(1);
  });

  it("keeps the only copy of an ingredient for an unmastered build", () => {
    expect(
      cleanupVerdict(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false }),
        context(),
      ).tier,
    ).toBe(0);
  });

  it("allows selling duplicate ingredients beyond the one the build needs", () => {
    expect(
      cleanupVerdict(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false, amount: 2 }),
        context(),
      ).disposableCopies,
    ).toBe(1);
  });

  it("steps the ingredient guard aside when mastery data is absent", () => {
    const degraded = buildSafetyContext({
      itemDb: DB,
      pinnedRequirements: new Map<string, number>(),
    });
    expect(degraded.degradedRules).toContain("unmasteredRecipe");
    expect(
      cleanupVerdict(
        weapon({ internalName: INGREDIENT, name: "Broken War", tradable: false }),
        degraded,
      ).tier,
    ).toBe(3);
  });
});

describe("part cleanup ordering", () => {
  it("ranks spares by ducats per platinum", () => {
    expect(partCleanupFields(3, 4.5)).toEqual({
      cleanupRank: 4.5,
      cleanupTie: null,
      cleanupCopies: 3,
    });
  });

  it("pushes rows without spares below every spare", () => {
    expect(partCleanupFields(0, 9)).toMatchObject({ cleanupRank: null, cleanupCopies: 0 });
  });

  it("keeps an unpriced spare above a non-spare through the copy tie-break", () => {
    expect(partCleanupFields(2, null)).toEqual({
      cleanupRank: null,
      cleanupTie: null,
      cleanupCopies: 2,
    });
  });
});

describe("cleanupFields and annotation", () => {
  const parts = { ...mod(), internalName: "part", inventoryGroup: "all_parts" as const };

  it("uses the spare count for parts and the tier for gear", () => {
    expect(
      cleanupFields(
        { ...parts, ducatonator: 3 },
        context(),
        {
          maxUnitValue: DEFAULT_CLEANUP_MAX_UNIT_VALUE,
        },
        2,
      ),
    ).toMatchObject({ cleanupRank: 3, cleanupCopies: 2 });
    expect(cleanupFields(mod(), context(), { maxUnitValue: 10 })).toMatchObject({
      cleanupRank: 3,
      cleanupCopies: 2,
    });
  });

  it("annotates without replacing rows whose values did not change", () => {
    const row = { ...mod(), cleanupRank: 3, cleanupTie: null, cleanupCopies: 2 };
    const [annotated] = annotateCleanupRows([row], context(), { maxUnitValue: 10 }, () => 0);
    expect(annotated).toBe(row);
  });

  it("annotates every row with the same options", () => {
    const [annotated] = annotateCleanupRows([mod()], context(), { maxUnitValue: 10 }, () => 0);
    expect(annotated).toMatchObject({ cleanupRank: 3, cleanupCopies: 2 });
  });
});
