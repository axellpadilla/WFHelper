import { derived, writable, type Readable } from "svelte/store";
import { readStoredJson, writeStorage } from "../lib/persistence.js";
import type { FilterScope, SharedFiltersState } from "../types/filters.js";

const STORAGE_KEY = "wfhelper:sharedFilters:v1";

const FILTER_SCOPES: readonly FilterScope[] = [
  "inventory",
  "mastery",
  "market",
  "foundry",
  "rivens",
];
const PRIME_MODES = ["all", "prime", "non_prime"] as const;
const MASTERED_MODES = ["all", "mastered", "not_mastered"] as const;
const YES_NO_MODES = ["all", "yes", "no"] as const;
const PART_TYPE_MODES = ["all", "normal", "prime"] as const;
const FOUNDRY_STATE_MODES = [
  "all",
  "claimable",
  "not_ready",
  "buildable",
  "buildable_sets",
] as const;
const SORT_KEYS = [
  "name",
  "owned",
  "platinum",
  "set-delta",
  "ducats",
  "amount",
  "count",
  "time",
  "disposition",
  "rerolls",
  "grade",
  "attr_grade",
  "ducatonator",
  "complete_sets",
  "missing_parts",
  "parts_owned",
  "mastery_xp",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function normalizeSharedFiltersByScope(value: unknown): Record<FilterScope, SharedFiltersState> {
  const filters = createDefaultFiltersByScope();
  if (!isRecord(value)) return filters;

  for (const scope of FILTER_SCOPES) {
    const saved = value[scope];
    if (!isRecord(saved)) continue;
    const next = filters[scope];

    // Search is intentionally ephemeral: a stale query must never hide items after startup.
    if (isOneOf(saved.primeMode, PRIME_MODES)) next.primeMode = saved.primeMode;
    if (isOneOf(saved.masteredMode, MASTERED_MODES)) next.masteredMode = saved.masteredMode;
    if (isOneOf(saved.sortBy, SORT_KEYS)) next.sortBy = saved.sortBy;
    if (saved.sortDirection === "asc" || saved.sortDirection === "desc") {
      next.sortDirection = saved.sortDirection;
    }
    if (isOneOf(saved.orderPlaced, YES_NO_MODES)) next.orderPlaced = saved.orderPlaced;
    if (isOneOf(saved.mastered, YES_NO_MODES)) next.mastered = saved.mastered;
    if (isOneOf(saved.spares, YES_NO_MODES)) next.spares = saved.spares;
    if (isOneOf(saved.vaulted, YES_NO_MODES)) next.vaulted = saved.vaulted;
    if (isOneOf(saved.partType, PART_TYPE_MODES)) next.partType = saved.partType;
    if (isOneOf(saved.favorite, YES_NO_MODES)) next.favorite = saved.favorite;
    if (isOneOf(saved.equipped, YES_NO_MODES)) next.equipped = saved.equipped;
    if (isOneOf(saved.leveledUp, YES_NO_MODES)) next.leveledUp = saved.leveledUp;
    if (isOneOf(saved.subsumed, YES_NO_MODES)) next.subsumed = saved.subsumed;
    if (isOneOf(saved.foundryState, FOUNDRY_STATE_MODES)) next.foundryState = saved.foundryState;
    if (typeof saved.minimumPlatinum === "number" && Number.isFinite(saved.minimumPlatinum)) {
      next.minimumPlatinum = Math.max(0, Math.min(1_000_000, Math.floor(saved.minimumPlatinum)));
    }
    if (typeof saved.minimumDucats === "number" && Number.isFinite(saved.minimumDucats)) {
      next.minimumDucats = Math.max(0, Math.min(1_000_000, Math.floor(saved.minimumDucats)));
    }
    if (saved.minimumAmount === 0 || saved.minimumAmount === 2) {
      next.minimumAmount = saved.minimumAmount;
    }
  }

  return filters;
}

function persistSharedFiltersByScope(filters: Record<FilterScope, SharedFiltersState>): void {
  const persisted = Object.fromEntries(
    FILTER_SCOPES.map((scope) => {
      const { search: _search, ...savedFilters } = filters[scope];
      return [scope, savedFilters];
    }),
  );
  writeStorage(STORAGE_KEY, JSON.stringify(persisted));
}

function updateFilters(
  update: (
    current: Record<FilterScope, SharedFiltersState>,
  ) => Record<FilterScope, SharedFiltersState>,
): void {
  sharedFiltersByScope.update((current) => {
    const next = update(current);
    persistSharedFiltersByScope(next);
    return next;
  });
}

function createDefaultSharedFiltersState(): SharedFiltersState {
  return {
    search: "",
    primeMode: "all",
    masteredMode: "all",
    sortBy: "name",
    sortDirection: "asc",
    orderPlaced: "all",
    mastered: "all",
    spares: "all",
    vaulted: "all",
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    minimumDucats: 0,
    minimumAmount: 0,
    equipped: "all",
    leveledUp: "all",
    subsumed: "all",
    foundryState: "all",
  };
}

function createDefaultFiltersByScope(): Record<FilterScope, SharedFiltersState> {
  return {
    inventory: createDefaultSharedFiltersState(),
    mastery: createDefaultSharedFiltersState(),
    market: createDefaultSharedFiltersState(),
    foundry: {
      ...createDefaultSharedFiltersState(),
      sortBy: "count",
      sortDirection: "desc",
    },
    rivens: createDefaultSharedFiltersState(),
  };
}

const sharedFiltersByScope = writable<Record<FilterScope, SharedFiltersState>>(
  readStoredJson(STORAGE_KEY, normalizeSharedFiltersByScope, createDefaultFiltersByScope),
);

export function sharedFilters(scope: FilterScope): Readable<SharedFiltersState> {
  return derived(sharedFiltersByScope, ($filters) => $filters[scope]);
}

export function updateSharedFilters(scope: FilterScope, patch: Partial<SharedFiltersState>): void {
  updateFilters((current) => ({
    ...current,
    [scope]: { ...current[scope], ...patch },
  }));
}

/** Put single fields back to the scope default. Hiding a filter bar control calls
    this so a control the user can no longer see cannot keep filtering the list. */
export function resetSharedFilterFields(
  scope: FilterScope,
  fields: readonly (keyof SharedFiltersState)[],
): void {
  if (fields.length === 0) return;
  const defaults = createDefaultFiltersByScope()[scope];
  const patch: Partial<SharedFiltersState> = {};
  for (const field of fields) Object.assign(patch, { [field]: defaults[field] });
  updateSharedFilters(scope, patch);
}

export function resetSharedFilters(scope: FilterScope): void {
  updateFilters((current) => ({
    ...current,
    // Per-scope defaults: foundry resets to count/desc, not the generic name/asc.
    [scope]: createDefaultFiltersByScope()[scope],
  }));
}
