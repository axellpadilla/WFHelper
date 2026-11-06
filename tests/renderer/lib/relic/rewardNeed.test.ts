import { describe, expect, it } from "vitest";

import { buildSafetyContext, recipeCopiesFor } from "../../../../src/lib/inventory/safetyRules.js";
import { isRewardNeeded, type RewardNeedContext } from "../../../../src/lib/relic/rewardNeed.js";
import type { ItemDbEntry, MasteryStatus } from "../../../../src/types/inventory.js";
import type { RelicReward } from "../../../../src/types/relics.js";

const CHASSIS_COMPONENT = "/Lotus/Types/Recipes/WarframeRecipes/SarynPrimeChassisComponent";
const CHASSIS_BLUEPRINT = "/Lotus/Types/Recipes/WarframeRecipes/SarynPrimeChassisBlueprint";
const SARYN_PRIME = "/Lotus/Powersuits/Mag/SarynPrime";
const LEX_BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/PrimeLexBarrel";
const LEX_PRIME = "/Lotus/Weapons/Tenno/Pistol/PrimeLex";
const AKLEX_PRIME = "/Lotus/Weapons/Tenno/Pistol/PrimeAkLex";
const FORMA_BLUEPRINT = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const FORMA = "/Lotus/Types/Recipes/Components/Forma";

const ITEM_DB: Record<string, ItemDbEntry> = {
  [SARYN_PRIME]: {
    name: "Saryn Prime",
    masterable: true,
    components: [{ name: "Chassis", uniqueName: CHASSIS_COMPONENT, itemCount: 1 }],
  },
  [CHASSIS_COMPONENT]: {
    name: "Saryn Prime Chassis",
    isBuildComponent: true,
    componentOf: SARYN_PRIME,
  },
  [LEX_PRIME]: {
    name: "Lex Prime",
    masterable: true,
    components: [{ name: "Barrel", uniqueName: LEX_BARREL, itemCount: 1 }],
  },
  [LEX_BARREL]: { name: "Lex Prime Barrel", isBuildComponent: true, componentOf: LEX_PRIME },
  [AKLEX_PRIME]: {
    name: "Aklex Prime",
    masterable: true,
    components: [{ name: "Lex Prime", uniqueName: LEX_PRIME, itemCount: 2 }],
  },
};

function makeReward(overrides: Partial<RelicReward> = {}): RelicReward {
  return {
    name: "Saryn Prime Chassis",
    uniqueName: CHASSIS_COMPONENT,
    rarity: "Common",
    chance: 25,
    urlName: "saryn_prime_chassis",
    ducats: 45,
    ...overrides,
  };
}

interface ContextOverrides {
  itemDb?: Record<string, ItemDbEntry>;
  owned?: Record<string, number>;
  building?: string[];
  mastery?: Record<string, MasteryStatus>;
  /** Absent means no mastery data at all, which degrades the recipe walk. */
  masteryKnown?: boolean;
  ownedByName?: boolean;
}

function makeContext(overrides: ContextOverrides = {}): RewardNeedContext {
  const mastery = overrides.mastery ?? {};
  const mastered = new Set(
    Object.entries(mastery)
      .filter(([, status]) => status === "mastered")
      .map(([uniqueName]) => uniqueName),
  );
  const building = new Set(overrides.building ?? []);
  return {
    safety: buildSafetyContext({
      itemDb: overrides.itemDb ?? ITEM_DB,
      ...(overrides.masteryKnown === false ? {} : { masteredUniqueNames: mastered }),
      ownedCounts: new Map(Object.entries(overrides.owned ?? {})),
      buildingUniqueNames: building,
    }),
    building,
    mastery: new Map(Object.entries(mastery)),
    uniqueNameOf: (reward) => reward.uniqueName || null,
    ownedByName: () => overrides.ownedByName ?? false,
  };
}

describe("isRewardNeeded", () => {
  it("needs a reward nothing in the account accounts for", () => {
    expect(isRewardNeeded(makeReward(), makeContext())).toBe(true);
  });

  it("does not need a part held under the other spelling", () => {
    const ctx = makeContext({ owned: { [CHASSIS_BLUEPRINT]: 1 } });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(false);
  });

  it("does not need a part whose parent is in the foundry", () => {
    const ctx = makeContext({ building: [SARYN_PRIME] });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(false);
  });

  it("does not need a part whose parent is built", () => {
    const ctx = makeContext({ owned: { [SARYN_PRIME]: 1 } });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(false);
  });

  it("does not need a part whose parent is mastered but no longer owned", () => {
    const ctx = makeContext({ mastery: { [SARYN_PRIME]: "mastered" } });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(false);
  });

  it("does not need a whole item that is mastered", () => {
    const ctx = makeContext({
      itemDb: { [CHASSIS_COMPONENT]: { name: "Saryn Prime Chassis" } },
      mastery: { [CHASSIS_COMPONENT]: "mastered" },
    });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(false);
  });

  it("still needs a part whose parent is only in progress", () => {
    const ctx = makeContext({ mastery: { [SARYN_PRIME]: "progress" } });
    expect(isRewardNeeded(makeReward(), ctx)).toBe(true);
  });

  it("still needs a part of a mastered weapon that an unmastered akimbo pair consumes", () => {
    const barrel = makeReward({ name: "Lex Prime Barrel", uniqueName: LEX_BARREL });
    const ctx = makeContext({ owned: { [LEX_PRIME]: 1 }, mastery: { [LEX_PRIME]: "mastered" } });
    expect(isRewardNeeded(barrel, ctx)).toBe(true);
    const settled = makeContext({
      owned: { [LEX_PRIME]: 1 },
      mastery: { [LEX_PRIME]: "mastered", [AKLEX_PRIME]: "mastered" },
    });
    expect(isRewardNeeded(barrel, settled)).toBe(false);
  });

  it("stops needing a part once the account holds every claimed copy", () => {
    const barrel = makeReward({ name: "Lex Prime Barrel", uniqueName: LEX_BARREL });
    expect(isRewardNeeded(barrel, makeContext({ owned: { [LEX_BARREL]: 1 } }))).toBe(true);
    expect(isRewardNeeded(barrel, makeContext({ owned: { [LEX_BARREL]: 3 } }))).toBe(false);
  });

  it("falls back to the reward's own copies without mastery data", () => {
    expect(isRewardNeeded(makeReward(), makeContext({ masteryKnown: false }))).toBe(true);
    const held = makeContext({ masteryKnown: false, owned: { [CHASSIS_COMPONENT]: 1 } });
    expect(isRewardNeeded(makeReward(), held)).toBe(false);
  });

  it("falls back to the name check when the reward has no uniqueName", () => {
    const reward = makeReward({ uniqueName: null });
    expect(isRewardNeeded(reward, makeContext({ owned: { [SARYN_PRIME]: 1 } }))).toBe(true);
    expect(isRewardNeeded(reward, makeContext({ ownedByName: true }))).toBe(false);
  });

  it("never treats an unresolved Forma Blueprint reward as needed", () => {
    const reward = makeReward({
      name: "2X Forma Blueprint",
      uniqueName: null,
      urlName: "forma_blueprint",
    });
    expect(isRewardNeeded(reward, makeContext())).toBe(false);
  });

  it("ignores Forma Blueprint even when an unmastered recipe claims it", () => {
    const itemDb: Record<string, ItemDbEntry> = {
      [FORMA]: {
        name: "Forma",
        masterable: true,
        components: [{ name: "Forma Blueprint", uniqueName: FORMA_BLUEPRINT, itemCount: 1 }],
      },
      [FORMA_BLUEPRINT]: {
        name: "Forma Blueprint",
        isBuildComponent: true,
        componentOf: FORMA,
      },
    };
    const ctx = makeContext({ itemDb, mastery: { [FORMA]: "progress" } });
    expect(recipeCopiesFor(ctx.safety, FORMA_BLUEPRINT)).toBeGreaterThan(0);
    expect(
      isRewardNeeded(
        makeReward({
          name: "Forma Blueprint",
          uniqueName: FORMA_BLUEPRINT,
          urlName: "unresolved_reward_slug",
        }),
        ctx,
      ),
    ).toBe(false);
  });
});
