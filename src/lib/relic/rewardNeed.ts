import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../../config/shared/componentNames.js";
import { consumersOf, partConsumerIndex } from "../inventory/partConsumers.js";
import { recipeCopiesFor, type SafetyContext } from "../inventory/safetyRules.js";
import type { MasteryStatus } from "../../types/inventory.js";
import type { RelicReward } from "../../types/relics.js";

const FORMA_BLUEPRINT_UNIQUE_NAME = "/Lotus/Types/Recipes/Components/FormaBlueprint";

export interface RewardNeedContext {
  /** The safe-to-sell engine's context; its demand walk says what a part still owes. */
  safety: SafetyContext;
  /** Product uniqueNames sitting in the foundry, building or claimable. */
  building: ReadonlySet<string>;
  mastery: ReadonlyMap<string, MasteryStatus>;
  /** reward.uniqueName, else the WFM gameRef behind reward.urlName. */
  uniqueNameOf: (reward: RelicReward) => string | null;
  /** The parsed-inventory name/gameRef ownership check. */
  ownedByName: (reward: RelicReward) => boolean;
}

function heldOrMastered(uniqueName: string, ctx: RewardNeedContext): boolean {
  if (ownedComponentCount(uniqueName, ctx.safety.ownedCounts) > 0) return true;
  return componentUniqueNameAliases(uniqueName).some(
    (alias) => ctx.building.has(alias) || ctx.mastery.get(alias) === "mastered",
  );
}

function isFormaBlueprint(reward: RelicReward, uniqueName: string | null): boolean {
  if (
    [reward.uniqueName, uniqueName].some(
      (uniqueName) =>
        typeof uniqueName === "string" &&
        uniqueName.trim().toLowerCase() === FORMA_BLUEPRINT_UNIQUE_NAME.toLowerCase(),
    )
  ) {
    return true;
  }

  return [reward.name, reward.urlName].some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value
      .trim()
      .replace(/^\d+\s*x\s*/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    return normalized === "forma blueprint";
  });
}

/** A part is needed while the builds above it, at any depth, claim more copies
 *  than the account holds; anything else is needed until held or mastered.
 *  Mastered gear the player sold stays unneeded. */
export function isRewardNeeded(reward: RelicReward, ctx: RewardNeedContext): boolean {
  if (isFormaBlueprint(reward, reward.uniqueName || null)) return false;
  if (ctx.ownedByName(reward)) return false;

  const uniqueName = ctx.uniqueNameOf(reward);
  if (isFormaBlueprint(reward, uniqueName)) return false;
  if (!uniqueName) return true;

  // Without mastery data the walk cannot run and the reward's own copies decide.
  if (!ctx.safety.degradedRules.includes("unmasteredRecipe")) {
    const claimed = recipeCopiesFor(ctx.safety, uniqueName);
    if (claimed > 0) return claimed > ownedComponentCount(uniqueName, ctx.safety.ownedCounts);
    if (consumersOf(partConsumerIndex(ctx.safety.itemDb), uniqueName).length > 0) return false;
  }

  return !heldOrMastered(uniqueName, ctx);
}
