import { describe, expect, it } from "vitest";

import {
  ownedVoidTraceCount,
  ownedRelicQualities,
  relicGroupForDisplayName,
  summarizeRelicPlannerInventory,
} from "../../../../src/lib/relic/relicInventory.js";
import type { OwnedCounts, RelicDatabase, RelicGroup } from "../../../../src/types/relics.js";
import type { ParsedItem, RawInventoryData } from "../../../../src/types/inventory.js";

function makeGroup(tier: string, code: string): RelicGroup {
  return {
    key: `${tier} ${code}`,
    name: `${tier} ${code}`,
    tier,
    code,
    imageUrl: null,
    qualities: {},
  };
}

const db: RelicDatabase = {
  groups: {
    "Lith A1": makeGroup("Lith", "A1"),
    "Meso B2": makeGroup("Meso", "B2"),
    "Requiem I": makeGroup("Requiem", "I"),
  },
  byUniqueName: {},
};

describe("relicGroupForDisplayName", () => {
  it("resolves the drop-table spelling", () => {
    expect(relicGroupForDisplayName(db, "Lith A1 Relic")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Requiem I Relic")?.key).toBe("Requiem I");
  });

  it("tolerates a missing suffix, odd spacing and case", () => {
    expect(relicGroupForDisplayName(db, "meso b2")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "  LITH   a1   relic ")?.key).toBe("Lith A1");
  });

  it("drops a refinement in parentheses in either position", () => {
    expect(relicGroupForDisplayName(db, "Lith A1 Relic (Radiant)")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Lith A1 (Intact) Relic")?.key).toBe("Lith A1");
  });

  it("resolves the acquisition-list spellings and skips a plain location", () => {
    // The acquisition-list spellings DropsList feeds in.
    expect(relicGroupForDisplayName(db, "Lith A1 Relic (Intact)")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Meso B2 Relic (Exceptional)")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Meso B2 Relic (Flawless)")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Meso B2")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Grineer Settlement (Mars)")).toBeNull();
  });

  it("returns null for an unknown relic, empty input or no database", () => {
    expect(relicGroupForDisplayName(db, "Axi Z9 Relic")).toBeNull();
    expect(relicGroupForDisplayName(db, "Relic")).toBeNull();
    expect(relicGroupForDisplayName(db, "")).toBeNull();
    expect(relicGroupForDisplayName(null, "Lith A1 Relic")).toBeNull();
  });
});

describe("owned relic refinements", () => {
  const counts: OwnedCounts = {
    "Lith A1": { intact: 3, exceptional: 0, flawless: 0, radiant: 2 },
    "Meso B2": { intact: 0, exceptional: 0, flawless: 0, radiant: 0 },
  };

  it("lists only the refinements held, in the game's tier order", () => {
    expect(ownedRelicQualities(counts, "Lith A1")).toEqual([
      { quality: "intact", count: 3 },
      { quality: "radiant", count: 2 },
    ]);
  });

  it("says nothing for a relic held at no refinement or never seen", () => {
    expect(ownedRelicQualities(counts, "Meso B2")).toEqual([]);
    expect(ownedRelicQualities(counts, "Axi Z9")).toEqual([]);
    expect(ownedRelicQualities({}, "Lith A1")).toEqual([]);
  });
});

describe("ownedVoidTraceCount", () => {
  it("reads the raw Void Traces resource stack", () => {
    const inventory: RawInventoryData = {
      MiscItems: [{ ItemType: "/Lotus/Types/Items/MiscItems/VoidTearDrop", ItemCount: 385 }],
    };

    expect(ownedVoidTraceCount(inventory)).toBe(385);
  });

  it("treats an absent raw resource row as a known zero", () => {
    expect(ownedVoidTraceCount({ MiscItems: [] })).toBe(0);
  });

  it("falls back to a parsed Void Traces row when raw resources are unavailable", () => {
    const parsed: ParsedItem[] = [
      { name: "Void Traces", internalName: "void-traces", amount: 205 } as ParsedItem,
    ];

    expect(ownedVoidTraceCount(null, parsed)).toBe(205);
    expect(ownedVoidTraceCount(null)).toBeNull();
  });
});

describe("summarizeRelicPlannerInventory", () => {
  it("totals Intact and Radiant relics only for the supplied visible groups", () => {
    const owned: OwnedCounts = {
      "Lith A1": { intact: 3, exceptional: 1, flawless: 0, radiant: 2 },
      "Meso B2": { intact: 5, exceptional: 0, flawless: 0, radiant: 4 },
      "Requiem I": { intact: 9, exceptional: 0, flawless: 0, radiant: 8 },
    };

    expect(
      summarizeRelicPlannerInventory([db.groups["Lith A1"], db.groups["Meso B2"]], owned, 299),
    ).toEqual({
      intact: 8,
      radiant: 6,
      voidTraces: 299,
      affordableRadiantRefinements: 2,
    });
  });

  it("omits an unknown Void Trace budget", () => {
    expect(summarizeRelicPlannerInventory([], {}, null)).toEqual({
      intact: 0,
      radiant: 0,
      voidTraces: null,
      affordableRadiantRefinements: null,
    });
  });
});
