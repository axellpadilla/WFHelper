import {
  MARKET_STATS_MAX_POINTS,
  type MarketStatPoint,
} from "../../../config/shared/marketStats.js";
import { fetchBackendRaw } from "./backendLite.js";
import { withAbortTimeout } from "../../../config/shared/fetchWithTimeout.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_RANK = 20;
const REQUEST_TIMEOUT_MS = 10_000;
export const MARKET_STATS_CACHE_TTL_MS = 5 * 60_000;

interface ArchivedStatsBuckets {
  latest: MarketStatPoint[];
  ninetyDays: MarketStatPoint[];
}

export function isMarketStatsCacheFresh(fetchedAt: number, now = Date.now()): boolean {
  const age = now - fetchedAt;
  return Number.isFinite(fetchedAt) && age >= 0 && age < MARKET_STATS_CACHE_TTL_MS;
}

/** Uses the archived daily rows as both the latest series and its 90-day slice. */
export function buildArchivedStatsBuckets(
  points: readonly MarketStatPoint[],
  now = Date.now(),
): ArchivedStatsBuckets | null {
  if (points.length === 0) return null;
  const latest = [...points].sort((a, b) => a.time - b.time);
  return {
    latest,
    ninetyDays: latest.filter((point) => point.time >= now - 90 * DAY_MS),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pointFrom(row: unknown, now: number): MarketStatPoint | null {
  if (!Array.isArray(row) || row.length < 3) return null;
  const [date, rank, median, volume] = row as [unknown, unknown, unknown, unknown];
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time) || time <= 0 || time > now + DAY_MS) return null;
  if (
    rank != null &&
    (!Number.isInteger(rank) || (rank as number) < 0 || (rank as number) > MAX_RANK)
  )
    return null;
  if (!finite(median) || median <= 0) return null;
  if (volume != null && (!finite(volume) || volume < 0)) return null;

  return {
    source: "archive",
    time,
    volume: finite(volume) ? volume : null,
    median,
    movingAvg: null,
    avgPrice: null,
    openPrice: null,
    closedPrice: null,
    minPrice: null,
    maxPrice: null,
    donchTop: null,
    donchBot: null,
    rank: rank == null ? null : (rank as number),
  };
}

/** Daily rows of a `/v1/price-history/{slug}` body; anything malformed is dropped. */
export function parsePriceHistoryRows(payload: unknown, now: number): MarketStatPoint[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const body = payload as { ok?: unknown; rows?: unknown };
  if (body.ok !== true || !Array.isArray(body.rows)) return [];

  const points: MarketStatPoint[] = [];
  for (const row of body.rows) {
    const point = pointFrom(row, now);
    if (point) points.push(point);
  }
  if (points.length <= MARKET_STATS_MAX_POINTS) return points;
  // An 11-rank mod passes the cap within the 730-day archive; keep its newest days.
  return points.sort((a, b) => a.time - b.time).slice(-MARKET_STATS_MAX_POINTS);
}

/** The Worker's folded price archive for one item; null when the backend has nothing. */
export async function fetchBackendPriceHistory(slug: string): Promise<MarketStatPoint[] | null> {
  try {
    return await withAbortTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetchBackendRaw(`/v1/price-history/${encodeURIComponent(slug)}`, {
        signal,
      });
      if (!response || !response.ok) return null;
      return parsePriceHistoryRows(await response.json(), Date.now());
    });
  } catch {
    return null;
  }
}
