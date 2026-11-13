import { partDemandAliases } from "./partConsumers.js";
import {
  grossRecipeDemand,
  reserveUnitsToCopies,
  safetyKeyFor,
  type SafetyContext,
} from "./safetyRules.js";
import type { InventoryGroup, ItemDbEntry } from "../../types/inventory.js";

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

/** What the shared filter reads and the `junk` sort compares. */
interface JunkFields {
  /** 0 (keep) to 100 (perfect junk). */
  junkScore?: number;
  /** Copies a future build, a pin or set-keep still claims: always sort last. */
  junkBuildLater?: boolean;
  junkCopies?: number | null;
}

const NONE: JunkFields = {
  junkScore: 0,
  junkBuildLater: false,
  junkCopies: 0,
};

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveNumber(value: unknown): number | null {
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

/** Per-copy platinum value alone: the lower it is, the more disposable. */
function platinumBand(platinum: number | null): number {
  if (platinum == null) return 100;
  if (platinum <= 1) return 95;
  if (platinum <= 5) return 85;
  if (platinum <= 10) return 70;
  if (platinum <= 20) return 55;
  if (platinum <= 50) return 35;
  if (platinum <= 100) return 15;
  return 0;
}

function gearBase(item: JunkItem): number {
  if (item.tradable !== true) return 100;
  return platinumBand(positiveNumber(item.platinum));
}

/** Parts also weigh ducats per platinum: a cheap part whose ducats beat its
 *  platinum is better Baro fodder, but the per-copy price still dominates. */
function partBase(item: JunkItem): number {
  if (item.tradable !== true) return 100;
  const platinum = positiveNumber(item.platinum);
  if (platinum == null) return 100;
  const ratio = positiveNumber(item.ducatonator) ?? 0;
  const ducats = Math.min(100, Math.round(ratio * 20));
  return Math.round(platinumBand(platinum) * 0.75 + ducats * 0.25);
}

/** Quantity nudges the score up, but it can never turn an expensive pile into
 *  junk: a 100p copy stays below the useful threshold even at 100 copies. */
function quantityFactor(copies: number): number {
  if (copies <= 1) return 1;
  return 1 + Math.min(0.25, 0.05 * Math.log2(copies));
}

function scoreFor(base: number, copies: number): number {
  if (copies <= 0 || base <= 0) return 0;
  return Math.min(100, Math.round(base * quantityFactor(copies)));
}

function later(later: boolean): JunkFields {
  return later ? { ...NONE, junkBuildLater: true } : NONE;
}

/**
 * Destruction-safety, deliberately separate from `safeToList`: the trade engine
 * floors untradeable rows and built gear to "keep all", which is right for
 * listing but would hide exactly the chaff this feature exists to surface.
 */
export function junkFields(item: JunkItem, context: SafetyContext): JunkFields {
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
    if (copies <= 0) return later(pinned > 0 || setKeep > 0);
    return {
      junkScore: scoreFor(gearBase(item), copies),
      junkBuildLater: false,
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
    if (copies <= 0) return later(needed > 0 || pinned > 0 || setKeep > 0);
    return {
      junkScore: scoreFor(gearBase(item), copies),
      junkBuildLater: false,
      junkCopies: copies,
    };
  }

  const copies = amount - Math.max(spare, pinned, setKeep, needed);
  if (copies <= 0) return later(needed > 0 || pinned > 0 || setKeep > 0);
  return {
    junkScore: scoreFor(partBase(item), copies),
    junkBuildLater: false,
    junkCopies: copies,
  };
}

/** Re-emits only rows whose junk values changed, so hydration flushes do not
 *  churn the whole list. */
export function annotateJunkRows<T extends JunkItem>(
  rows: T[],
  context: SafetyContext,
): (T & JunkFields)[] {
  return rows.map((row) => {
    const fields = junkFields(row, context);
    const previous = row as T & JunkFields;
    if (
      previous.junkScore === fields.junkScore &&
      previous.junkBuildLater === fields.junkBuildLater &&
      previous.junkCopies === fields.junkCopies
    ) {
      return row as T & JunkFields;
    }
    return { ...row, ...fields };
  });
}
