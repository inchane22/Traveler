// Which festivals the weekly run verifies, in which order (PRD «Qué fiestas se verifican»). Pure.
import { diffDays, effectiveStart, type ISO, type Occurrence } from "../../src/dates.ts";
import { buildEntries } from "../../src/festivals.ts";
import type { CountryFile, Festival } from "../../src/schema.ts";
import type { ScoringConfig, Tier } from "../../src/score.ts";

export type QueueReason = "soon" | "unconfirmed" | "stale" | "manual";

export interface QueueItem {
  country: string;
  slug: string;
  festival: Festival;
  tier: Tier;
  /** Edition year the run verifies. */
  year: number;
  occurrence: Occurrence | null;
  /** Days from today to the start of the next edition; negative while ongoing; Infinity when unknown. */
  daysToStart: number;
  lastVerified: ISO | null;
  reasons: QueueReason[];
}

export interface QueueOptions {
  max: number;
  perCountry: number;
  only?: string;
  country?: string;
}

export const SOON_DAYS = 180;
export const STALE_DAYS = 30;
export const STALE_DAYS_NEAR = 14;
export const NEAR_DAYS = 120;
export const DEFAULT_MAX = 40;
export const DEFAULT_PER_COUNTRY = 10;

const TIER_ORDER: Record<string, number> = { "1": 0, "2": 1, provisional: 2, hidden: 3 };

export function reasonsFor(daysToStart: number, status: string, lastVerified: ISO | null, today: ISO): QueueReason[] {
  const reasons: QueueReason[] = [];
  if (daysToStart < SOON_DAYS) reasons.push("soon");
  if (status !== "confirmada") reasons.push("unconfirmed");
  const limit = daysToStart < NEAR_DAYS ? STALE_DAYS_NEAR : STALE_DAYS;
  if (!lastVerified || diffDays(lastVerified, today) > limit) reasons.push("stale");
  return reasons;
}

export function compareItems(a: QueueItem, b: QueueItem): number {
  const days = a.daysToStart === b.daysToStart ? 0 : a.daysToStart < b.daysToStart ? -1 : 1;
  return days || (TIER_ORDER[String(a.tier)] ?? 9) - (TIER_ORDER[String(b.tier)] ?? 9) || a.country.localeCompare(b.country) || a.slug.localeCompare(b.slug);
}

/** Candidates for one country, before ordering and caps. `force` (from --only) skips the entry rules. */
export function candidates(country: CountryFile, config: ScoringConfig, today: ISO, force?: string): QueueItem[] {
  return buildEntries(country, config, today).flatMap((entry) => {
    const occ = entry.occurrence;
    const daysToStart = occ ? diffDays(today, effectiveStart(occ)) : Number.POSITIVE_INFINITY;
    const status = occ?.status ?? "por_anunciar";
    const lastVerified = occ?.edition?.last_verified ?? null;
    const rules = reasonsFor(daysToStart, status, lastVerified, today);
    const reasons: QueueReason[] = entry.festival.slug === force && !rules.length ? ["manual"] : rules;
    if (!reasons.length) return [];
    return [
      {
        country: country.country,
        slug: entry.festival.slug,
        festival: entry.festival,
        tier: entry.score.tier,
        year: occ?.year ?? Number(today.slice(0, 4)) + 1,
        occurrence: occ,
        daysToStart,
        lastVerified,
        reasons,
      },
    ];
  });
}

/** Ordered by days to start then tier, max `perCountry` per country and `max` overall. */
export function buildQueue(countries: readonly CountryFile[], config: ScoringConfig, today: ISO, opts: QueueOptions): QueueItem[] {
  const wanted = opts.country?.toUpperCase();
  const all = countries
    .filter((c) => !wanted || c.country === wanted)
    .flatMap((c) => candidates(c, config, today, opts.only))
    .filter((item) => !opts.only || item.slug === opts.only)
    .sort(compareItems);
  const perCountry = new Map<string, number>();
  const out: QueueItem[] = [];
  for (const item of all) {
    if (out.length >= opts.max) break;
    const n = perCountry.get(item.country) ?? 0;
    if (n >= opts.perCountry) continue;
    perCountry.set(item.country, n + 1);
    out.push(item);
  }
  return out;
}
