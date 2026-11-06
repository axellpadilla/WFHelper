import type { BaroHistory } from "../../../config/shared/baroHistory.js";
import { fallbackNameFromUniqueName } from "../../../config/shared/displayName.js";
import { STAT_RESOURCES } from "../../../config/shared/statsTypes.js";
import type { RawInventoryData } from "../../types/inventory.js";
import type { ItemDbLookup } from "../../types/ipc.js";
import type { VaultTrader } from "../../types/world.js";
import { activeWindow } from "../format.js";
import { itemLabel } from "../itemLabel.js";
import { buildBaroOwnedSet } from "../world.js";

interface BaroCatalogRow {
  uniqueName: string;
  name: string;
  imageUrl: string | null;
  ducats: number | null;
  credits: number | null;
  available: boolean;
  lastSeen: number | null;
  owned: boolean;
  quantity: number;
}

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function quantity(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/Lotus/") && value.length <= 512;
}

export function buildBaroCatalog(
  history: BaroHistory | null,
  current: VaultTrader | null | undefined,
  inventory: RawInventoryData | null,
  itemDb: ItemDbLookup,
  wishlist: Record<string, number>,
  now: number,
): BaroCatalogRow[] {
  const owned = buildBaroOwnedSet(inventory);
  const past = new Map(history?.lastSeen.map((entry) => [entry.uniqueName, entry]));
  const offers = new Map<string, NonNullable<VaultTrader["inventory"]>[number]>();
  for (const offer of current?.inventory ?? []) {
    if (validName(offer?.uniqueName) && !offers.has(offer.uniqueName))
      offers.set(offer.uniqueName, offer);
  }
  const active = activeWindow(current?.activation, current?.expiry, now);
  const activation = Date.parse(current?.activation ?? "");
  const observedAt =
    Number.isFinite(activation) && activation > 0 && activation <= now ? activation : null;
  const identities = new Set([...past.keys(), ...offers.keys(), ...Object.keys(wishlist)]);
  return [...identities].filter(validName).map((uniqueName) => {
    const previous = past.get(uniqueName);
    const offer = offers.get(uniqueName);
    const db = itemDb[uniqueName];
    const currentName = typeof offer?.item === "string" ? offer.item.trim() : "";
    const lastSeen =
      offer && observedAt !== null
        ? Math.max(previous?.lastSeen ?? 0, observedAt)
        : (previous?.lastSeen ?? null);
    return {
      uniqueName,
      name: itemLabel(db) || currentName || fallbackNameFromUniqueName(uniqueName),
      imageUrl:
        (typeof offer?.imageOverride === "string" && offer.imageOverride) || db?.imageUrl || null,
      // An omitted current price is unknown even when an older visit quoted one.
      ducats: amount(offer ? offer.ducats : previous?.ducats),
      credits: amount(offer ? offer.credits : previous?.credits),
      available: active && !!offer,
      lastSeen,
      owned: owned.has(uniqueName),
      quantity: quantity(wishlist[uniqueName]),
    };
  });
}

function balance(inventory: RawInventoryData | null, id: "ducats" | "credits"): number | null {
  if (!inventory) return null;
  const source = STAT_RESOURCES.find((resource) => resource.id === id)?.source;
  if (!source) return null;
  if (source.kind === "field") return amount(inventory[source.field]);
  if (!Array.isArray(inventory.MiscItems)) return null;
  const row = inventory.MiscItems.find((entry) => entry?.ItemType === source.uniqueName);
  // DE removes exhausted resource stacks from an otherwise complete MiscItems array.
  return row ? amount(row.ItemCount) : 0;
}

export function baroBudget(
  rows: BaroCatalogRow[],
  inventory: RawInventoryData | null,
  options?: { excludeOwned?: boolean },
) {
  const ducats = balance(inventory, "ducats");
  const credits = balance(inventory, "credits");
  let totalDucats = 0;
  let totalCredits = 0;
  let unknownCosts = 0;
  let unavailableItems = 0;
  let unknownDucats = false;
  let unknownCredits = false;
  for (const row of rows) {
    const wished = quantity(row.quantity);
    const count = Math.max(0, wished - (options?.excludeOwned && row.owned ? 1 : 0));
    if (!count) continue;
    if (!row.available) {
      unavailableItems += 1;
      continue;
    }
    const ducatCost = amount(row.ducats);
    const creditCost = amount(row.credits);
    if (ducatCost === null || creditCost === null) unknownCosts += 1;
    if (ducatCost === null) unknownDucats = true;
    else totalDucats += ducatCost * count;
    if (creditCost === null) unknownCredits = true;
    else totalCredits += creditCost * count;
  }
  return {
    ducats,
    credits,
    totalDucats,
    totalCredits,
    unknownCosts,
    unknownDucats,
    unknownCredits,
    unavailableItems,
    ducatShortfall: ducats === null || unknownDucats ? null : Math.max(0, totalDucats - ducats),
    creditShortfall:
      credits === null || unknownCredits ? null : Math.max(0, totalCredits - credits),
  };
}
