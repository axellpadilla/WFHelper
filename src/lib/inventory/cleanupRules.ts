import { componentUniqueNameAliases } from "../../../config/shared/componentNames.js";
import { partDemandAliases } from "./partConsumers.js";
import {
  reservableParts,
  reserveUnitsToCopies,
  safetyKeyFor,
  type SafetyContext,
} from "./safetyRules.js";
import type { InventoryGroup, ItemDbEntry } from "../../types/inventory.js";

/** At or below this price a spare is chaff: cheap enough to transmute or sell
 *  for credits without thinking about the platinum left on the table. */
export const DEFAULT_CLEANUP_MAX_UNIT_VALUE = 10;

/** 3 = chaff, 2 = cheap spare, 1 = valuable spare, 0 = keep. */
type CleanupTier = 0 | 1 | 2 | 3;

/** The row fields the cleanup rules read. `InventoryViewItem` satisfies it. */
export interface CleanupItem {
  internalName: string;
  uniqueName?: string;
  name: string;
  inventoryGroup?: InventoryGroup;
  rank?: number;
  maxRank?: number;
  amount?: number | null;
  platinum?: number | null;
  ducatonator?: number | null;
  tradable?: boolean;
  equipped?: boolean;
  favorite?: boolean;
}

interface CleanupOptions {
  maxUnitValue: number;
}

interface CleanupVerdict {
  tier: CleanupTier;
  /** Copies this row can lose without touching builds, goals or the last copy. */
  disposableCopies: number;
  /** Per-copy platinum value; null when untradeable or still unpriced. */
  unitValue: number | null;
}

/** One value the sort compares, plus its tie-breaks. Parts rank by ducats per
 *  platinum, mods and equipment by cleanup tier. */
interface CleanupFields {
  cleanupRank?: number | null;
  cleanupTie?: number | null;
  cleanupCopies?: number | null;
}

const ZERO: CleanupVerdict = { tier: 0, disposableCopies: 0, unitValue: null };

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function pricedValue(item: CleanupItem): number | null {
  if (item.tradable !== true) return null;
  const value = item.platinum;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function aliasesFor(key: string, itemDb: Record<string, ItemDbEntry>): string[] {
  return key ? partDemandAliases(key, itemDb) : [];
}

function entryFor(
  aliases: readonly string[],
  itemDb: Record<string, ItemDbEntry>,
): ItemDbEntry | undefined {
  for (const alias of aliases) {
    const entry = itemDb[alias];
    if (entry) return entry;
  }
  return undefined;
}

/** Copies a pin or spare override asks to keep, in row copies. */
function demandCopies(
  demand: ReadonlyMap<string, number>,
  aliases: readonly string[],
  itemDb: Record<string, ItemDbEntry>,
): number {
  let units = 0;
  for (const alias of aliases) units = Math.max(units, demand.get(alias) ?? 0);
  return reserveUnitsToCopies(units, entryFor(aliases, itemDb));
}

interface IngredientCache {
  mastered: ReadonlySet<string>;
  value: ReadonlySet<string>;
}

// Keyed by the item database, then by the mastered set: settings edits rebuild
// the safety context but never the mastery index, so the walk stays cached.
const INGREDIENT_CACHE = new WeakMap<Record<string, ItemDbEntry>, IngredientCache>();

/** uniqueNames consumed by a recipe whose product is not mastered. Selling one
 *  of these means farming it again (Broken War -> War, Bolto -> Akbolto). */
function unmasteredIngredients(
  itemDb: Record<string, ItemDbEntry>,
  mastered: ReadonlySet<string>,
): ReadonlySet<string> {
  const cached = INGREDIENT_CACHE.get(itemDb);
  if (cached && cached.mastered === mastered) return cached.value;

  const value = new Set<string>();
  for (const [root, entry] of Object.entries(itemDb)) {
    if (entry.masterable !== true || mastered.has(root)) continue;
    for (const part of reservableParts(itemDb, root)) {
      const uniqueName = typeof part.uniqueName === "string" ? part.uniqueName : "";
      if (!uniqueName) continue;
      for (const alias of componentUniqueNameAliases(uniqueName)) value.add(alias);
    }
  }
  INGREDIENT_CACHE.set(itemDb, { mastered, value });
  return value;
}

function tierFor(
  copies: number,
  unitValue: number | null,
  options: CleanupOptions,
): CleanupVerdict {
  if (copies <= 0) return ZERO;
  if (unitValue == null) return { tier: 3, disposableCopies: copies, unitValue };
  const tier: CleanupTier = unitValue <= options.maxUnitValue ? 2 : 1;
  return { tier, disposableCopies: copies, unitValue };
}

/**
 * Destruction-safety, deliberately separate from `safeToList`: the trade engine
 * floors untradeable rows and built gear to "keep all", which is right for
 * listing but would hide exactly the chaff this feature exists to surface.
 */
export function cleanupVerdict(
  item: CleanupItem,
  context: SafetyContext,
  options: CleanupOptions = { maxUnitValue: DEFAULT_CLEANUP_MAX_UNIT_VALUE },
): CleanupVerdict {
  const group = item.inventoryGroup;
  if (group !== "mods" && group !== "equipment") return ZERO;

  const key = safetyKeyFor(item);
  if (context.locks.has(key)) return ZERO;
  if (item.favorite === true || item.equipped === true) return ZERO;

  const amount = Math.max(1, finiteCount(item.amount));
  const aliases = aliasesFor(key, context.itemDb);
  const kept = Math.max(
    0,
    finiteCount(context.spares.get(key) ?? context.spareDefault),
    demandCopies(context.pinnedDemand, aliases, context.itemDb),
  );

  if (group === "mods") {
    // A ranked copy carries invested endo and usually sells for more at rank;
    // never suggest one as transmute fodder.
    if ((item.rank ?? 0) > 0) return ZERO;
    // Keep one copy of the mod itself even when every rank row is split out.
    return tierFor(amount - Math.max(1, kept), pricedValue(item), options);
  }

  const maxRank = finiteCount(item.maxRank);
  const mastered =
    (maxRank > 0 && (item.rank ?? 0) >= maxRank) ||
    aliases.some((alias) => context.mastered.has(alias));
  if (!mastered) return ZERO;

  // Mastery data can be absent at startup; treating every ingredient as needed
  // then would hide the whole equipment tab, so the guard steps aside instead.
  const degraded = context.degradedRules.includes("unmasteredRecipe");
  const needed =
    !degraded &&
    aliases.some((alias) => unmasteredIngredients(context.itemDb, context.mastered).has(alias))
      ? 1
      : 0;

  return tierFor(amount - Math.max(needed, kept), pricedValue(item), options);
}

/**
 * Prime parts rank by ducats per platinum once the safety engine says the copy
 * is spare; a spare with no price yet sorts last until hydration lands.
 */
export function partCleanupFields(spareCopies: number, ducatonator: number | null): CleanupFields {
  const copies = finiteCount(spareCopies);
  if (copies <= 0) return { cleanupRank: null, cleanupTie: null, cleanupCopies: 0 };
  const ratio =
    typeof ducatonator === "number" && Number.isFinite(ducatonator) && ducatonator > 0
      ? ducatonator
      : null;
  return { cleanupRank: ratio, cleanupTie: null, cleanupCopies: copies };
}

/** Group-aware annotation: parts use `spareCopies`, gear uses the tier. */
export function cleanupFields(
  item: CleanupItem,
  context: SafetyContext,
  options: CleanupOptions,
  spareCopies = 0,
): CleanupFields {
  if (item.inventoryGroup === "all_parts") {
    return partCleanupFields(spareCopies, item.ducatonator ?? null);
  }
  const verdict = cleanupVerdict(item, context, options);
  return {
    cleanupRank: verdict.tier > 0 ? verdict.tier : null,
    cleanupTie: verdict.unitValue,
    cleanupCopies: verdict.disposableCopies,
  };
}

/** Re-emits only rows whose cleanup values changed, so hydration flushes do not
 *  churn the whole list. */
export function annotateCleanupRows<T extends CleanupItem>(
  rows: T[],
  context: SafetyContext,
  options: CleanupOptions,
  spareCopiesFor: (row: T) => number,
): (T & CleanupFields)[] {
  return rows.map((row) => {
    const fields = cleanupFields(row, context, options, spareCopiesFor(row));
    const previous = row as T & CleanupFields;
    if (
      previous.cleanupRank === fields.cleanupRank &&
      previous.cleanupTie === fields.cleanupTie &&
      previous.cleanupCopies === fields.cleanupCopies
    ) {
      return row as T & CleanupFields;
    }
    return { ...row, ...fields };
  });
}
