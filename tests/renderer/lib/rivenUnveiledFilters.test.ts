import { describe, expect, it } from "vitest";

import { computeRivenEndo } from "../../../config/shared/rivenEndo.js";
import { applySharedFiltersAndSort, defaultSortDirection } from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";
import {
  filterUnveiledRivens,
  formatRivenListSummary,
  type UnveiledRivenFilters,
} from "../../../src/lib/rivens/unveiledFilters.js";

function defaultFilters(overrides: Partial<SharedFiltersState> = {}): SharedFiltersState {
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
    ...overrides,
  };
}

const noUnveiledFilters: UnveiledRivenFilters = {
  listing: "all",
  rolls: "all",
  polarity: "all",
};

const rivens = [
  { itemId: "listed-unrolled", rerolls: 0, polarity: "Madurai" },
  { itemId: "unlisted-rolled", rerolls: 3, polarity: "vAzArIn" },
  { itemId: "listed-rolled", rerolls: 1, polarity: "Naramon" },
];
const listed = new Set(["listed-unrolled", "listed-rolled"]);
const isListed = (riven: (typeof rivens)[number]) => listed.has(riven.itemId);

describe("unveiled Riven filters", () => {
  it("sorts by dissolve Endo with the best value first by default", () => {
    const low = computeRivenEndo({ masteryRank: 12, modRank: 0, rerolls: 0 });
    const high = computeRivenEndo({ masteryRank: 16, modRank: 8, rerolls: 2 });
    const items = [
      { name: "Low", endo: low },
      { name: "High", endo: high },
    ];

    expect(defaultSortDirection("endo")).toBe("desc");
    expect(
      applySharedFiltersAndSort(
        items,
        defaultFilters({ sortBy: "endo", sortDirection: defaultSortDirection("endo") }),
      ).map((item) => item.name),
    ).toEqual(["High", "Low"]);
  });

  it("filters by matched listing status", () => {
    expect(
      filterUnveiledRivens(rivens, { ...noUnveiledFilters, listing: "listed" }, isListed).map(
        (riven) => riven.itemId,
      ),
    ).toEqual(["listed-unrolled", "listed-rolled"]);
    expect(
      filterUnveiledRivens(rivens, { ...noUnveiledFilters, listing: "unlisted" }, isListed).map(
        (riven) => riven.itemId,
      ),
    ).toEqual(["unlisted-rolled"]);
  });

  it("filters unrolled and rolled Rivens", () => {
    expect(
      filterUnveiledRivens(rivens, { ...noUnveiledFilters, rolls: "unrolled" }, isListed).map(
        (riven) => riven.itemId,
      ),
    ).toEqual(["listed-unrolled"]);
    expect(
      filterUnveiledRivens(rivens, { ...noUnveiledFilters, rolls: "rolled" }, isListed).map(
        (riven) => riven.itemId,
      ),
    ).toEqual(["unlisted-rolled", "listed-rolled"]);
  });

  it("matches polarity without regard to case", () => {
    expect(
      filterUnveiledRivens(rivens, { ...noUnveiledFilters, polarity: "vazarin" }, isListed).map(
        (riven) => riven.itemId,
      ),
    ).toEqual(["unlisted-rolled"]);
  });
});

describe("formatRivenListSummary", () => {
  const riven = {
    weaponName: "Lato",
    stats: [
      {
        tag: "criticalChance",
        name: "Critical Chance",
        displayValue: 120,
        maxRankValue: 120,
        rollFloat: 0.8,
        grade: "S",
        positive: true,
        multiplier: false,
      },
      {
        tag: "damage",
        name: "Damage",
        displayValue: 90,
        maxRankValue: 90,
        rollFloat: 0.7,
        grade: "A",
        positive: true,
        multiplier: false,
      },
      {
        tag: "zoom",
        name: "Zoom",
        displayValue: -10,
        maxRankValue: -10,
        rollFloat: 0.5,
        grade: "B",
        positive: false,
        multiplier: false,
      },
    ],
    masteryReq: 16,
    polarity: "VAZARIN",
    rerolls: 0,
    overallGrade: "S",
  };

  it("formats listed prices and identifies unlisted Rivens on separate lines", () => {
    expect(
      formatRivenListSummary([
        { riven, contract: { platinum: 300, buyoutPlatinum: 250 } },
        { riven: { ...riven, weaponName: "Lex" }, contract: null },
      ]),
    ).toBe(
      "Lato — +Critical Chance / +Damage / -Zoom | MR16 Vazarin | 0 rolls | Grade S | 250p\n" +
        "Lex — +Critical Chance / +Damage / -Zoom | MR16 Vazarin | 0 rolls | Grade S | Unlisted",
    );
  });

  it("returns an empty string for an empty filtered list", () => {
    expect(formatRivenListSummary([])).toBe("");
  });
});
