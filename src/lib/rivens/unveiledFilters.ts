import type { DecodedRiven } from "../../types/ipc.js";
import type { WfmContract } from "../../types/market.js";

export type ListingStatusFilter = "all" | "listed" | "unlisted";
export type RollStatusFilter = "all" | "unrolled" | "rolled";
export type RivenPolarityFilter = "all" | "madurai" | "vazarin" | "naramon";

export interface UnveiledRivenFilters {
  listing: ListingStatusFilter;
  rolls: RollStatusFilter;
  polarity: RivenPolarityFilter;
}

interface UnveiledRivenFilterable {
  rerolls: number;
  polarity: string;
}

export function filterUnveiledRivens<T extends UnveiledRivenFilterable>(
  rivens: readonly T[],
  filters: UnveiledRivenFilters,
  isListed: (riven: T) => boolean,
): T[] {
  return rivens.filter((riven) => {
    if (filters.listing === "listed" && !isListed(riven)) return false;
    if (filters.listing === "unlisted" && isListed(riven)) return false;
    if (filters.rolls === "unrolled" && riven.rerolls !== 0) return false;
    if (filters.rolls === "rolled" && riven.rerolls <= 0) return false;
    if (filters.polarity !== "all" && riven.polarity.trim().toLowerCase() !== filters.polarity) {
      return false;
    }
    return true;
  });
}

type SummaryRiven = Pick<
  DecodedRiven,
  "weaponName" | "stats" | "masteryReq" | "polarity" | "rerolls" | "overallGrade"
>;

interface RivenListSummaryEntry {
  riven: SummaryRiven;
  contract: Pick<WfmContract, "platinum" | "buyoutPlatinum"> | null;
}

/** Concise, newline-separated English game-name summary suitable for sharing. */
export function formatRivenListSummary(entries: readonly RivenListSummaryEntry[]): string {
  return entries
    .map(({ riven, contract }) => {
      const stats = riven.stats
        .map((stat) => `${stat.positive ? "+" : "-"}${stat.name}`)
        .join(" / ");
      const polarity = riven.polarity.trim();
      const normalizedPolarity = polarity
        ? polarity.charAt(0).toUpperCase() + polarity.slice(1).toLowerCase()
        : "Unknown";
      const price = contract ? `${contract.buyoutPlatinum ?? contract.platinum}p` : "Unlisted";
      return [
        `${riven.weaponName} — ${stats}`,
        `MR${riven.masteryReq} ${normalizedPolarity}`,
        `${riven.rerolls} rolls`,
        `Grade ${riven.overallGrade}`,
        price,
      ].join(" | ");
    })
    .join("\n");
}
