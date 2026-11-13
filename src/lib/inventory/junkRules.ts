import { partDemandAliases } from "./partConsumers.js";
import {
  grossRecipeDemand,
  reserveUnitsToCopies,
  safetyKeyFor,
  type SafetyContext,
} from "./safetyRules.js";
import type { InventoryGroup, ItemDbEntry } from "../../types/inventory.js";

/** At or below this price a disposable copy is chaff: cheap enough to transmute
 *  or sell for credits without thinking about the platinum left on the table. */
export const DEFAULT_JUNK_MAX_UNIT_VALUE = 10;

/** The row fields the junk rules read. `InventoryViewItem` satisfies it. */
export interface JunkItem {
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
  orderPlaced?: boolean;
}

interface JunkOptions {
  maxUnitValue: number;
}

/** What the shared filter reads and the `junk` sort compares. */
interface JunkFields {
  junk?: boolean;
  /** Copies a future build, a pin or set-keep still claims: always sort last. */
  junkBuildLater?: boolean;
  /** Tier for gear, ducats per platinum for parts. */
  junkRank?: number | null;
  junkTie?: number | null;
  junkCopies?: number | null;
}

const NONE: JunkFields = {
  junk: false,
  junkBuildLater: false,
  junkRank: null,
  junkTie: null,
  junkCopies: 0,
};

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pricedValue(item: JunkItem): number | null {
  if (item.tradable !== true) return null;
  return positiveNumber(item.platinum);
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

/** Copies a demand map asks from the row, across every alias spelling. */
function demandCopies(
  demand: ReadonlyMap<string, number>,
  aliases: readonly string[],
  itemDb: Record<string, ItemDbEntry>,
): number {
  let units = 0;
  for (const alias of aliases) units = Math.max(units, demand.get(alias) ?? 0);
  return reserveUnitsToCopies(units, entryFor(aliases, itemDb));
}

function tierFor(value: number | null, options: JunkOptions): number {
  if (value == null) return 3;
  return value <= options.maxUnitValue ? 2 : 1;
}

/** A copy kept for later: no junk, and the sort pins it to the bottom. */
function buildLater(later: boolean): JunkFields {
  return later ? { ...NONE, junkBuildLater: true } : NONE;
}

/**
 * Destruction-safety, deliberately separate from `safeToList`: the trade engine
 * floors untradeable rows and built gear to "keep all", which is right for
 * listing but would hide exactly the chaff this feature exists to surface.
 */
export function junkFields(
  item: JunkItem,
  context: SafetyContext,
  options: JunkOptions = { maxUnitValue: DEFAULT_JUNK_MAX_UNIT_VALUE },
): JunkFields {
  const group = item.inventoryGroup;
  if (group !== "all_parts" && group !== "mods" && group !== "equipment") return NONE;
  if (item.favorite === true || item.equipped === true || item.orderPlaced === true) return NONE;

  const key = safetyKeyFor(item);
  if (context.locks.has(key)) return NONE;

  const amount = Math.max(1, finiteCount(item.amount));
  const aliases = aliasesFor(key, context.itemDb);
  const spare = Math.max(0, finiteCount(context.spares.get(key) ?? context.spareDefault));
  const pinned = demandCopies(context.pinnedDemand, aliases, context.itemDb);
  const setKeep = demandCopies(context.setKeepDemand, aliases, context.itemDb);
  // Mastery data can be absent at startup; treating every part as needed then
  // would hide the whole tab, so the gross-demand guard steps aside.
  const degraded = context.degradedRules.includes("unmasteredRecipe");
  const needed = degraded
    ? 0
    : demandCopies(grossRecipeDemand(context.itemDb, context.mastered), aliases, context.itemDb);

  if (group === "mods") {
    // A ranked copy carries invested endo and usually sells for more at rank;
    // never suggest one as transmute fodder.
    if ((item.rank ?? 0) > 0) return NONE;
    const copies = amount - Math.max(1, spare, pinned);
    if (copies <= 0) return buildLater(pinned > 0 || setKeep > 0);
    const value = pricedValue(item);
    return {
      junk: value == null || value <= options.maxUnitValue,
      junkBuildLater: false,
      junkRank: tierFor(value, options),
      junkTie: value,
      junkCopies: copies,
    };
  }

  if (group === "equipment") {
    const maxRank = finiteCount(item.maxRank);
    const mastered =
      (maxRank > 0 && (item.rank ?? 0) >= maxRank) ||
      aliases.some((alias) => context.mastered.has(alias));
    if (!mastered) return NONE;
    const copies = amount - Math.max(spare, pinned, setKeep, needed);
    if (copies <= 0) return buildLater(needed > 0 || pinned > 0 || setKeep > 0);
    const value = pricedValue(item);
    return {
      junk: value == null || value <= options.maxUnitValue,
      junkBuildLater: false,
      junkRank: tierFor(value, options),
      junkTie: value,
      junkCopies: copies,
    };
  }

  // Prime parts: a copy is junk when it is spare and cheap, or when the ducats
  // are worth at least as much as the platinum it would cost to sell it.
  const copies = amount - Math.max(spare, pinned, setKeep, needed);
  if (copies <= 0) return buildLater(needed > 0 || pinned > 0 || setKeep > 0);
  const value = positiveNumber(item.platinum);
  const ratio = positiveNumber(item.ducatonator);
  return {
    junk: value == null || value <= options.maxUnitValue || (ratio != null && ratio >= 1),
    junkBuildLater: false,
    junkRank: ratio,
    junkTie: null,
    junkCopies: copies,
  };
}

/** Re-emits only rows whose junk values changed, so hydration flushes do not
 *  churn the whole list. */
export function annotateJunkRows<T extends JunkItem>(
  rows: T[],
  context: SafetyContext,
  options: JunkOptions = { maxUnitValue: DEFAULT_JUNK_MAX_UNIT_VALUE },
): (T & JunkFields)[] {
  return rows.map((row) => {
    const fields = junkFields(row, context, options);
    const previous = row as T & JunkFields;
    if (
      previous.junk === fields.junk &&
      previous.junkBuildLater === fields.junkBuildLater &&
      previous.junkRank === fields.junkRank &&
      previous.junkTie === fields.junkTie &&
      previous.junkCopies === fields.junkCopies
    ) {
      return row as T & JunkFields;
    }
    return { ...row, ...fields };
  });
}
