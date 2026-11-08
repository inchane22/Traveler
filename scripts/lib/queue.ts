// Which festivals the weekly run verifies, in which order (PRD «Qué fiestas se verifican»). Pure.
import { diffDays, effectiveStart, type ISO, type Occurrence } from "../../src/dates.ts";
import { buildEntries, isPendingPostponement } from "../../src/festivals.ts";
import type { CountryFile, Festival } from "../../src/schema.ts";
import type { ScoringConfig, Tier } from "../../src/score.ts";

export type QueueReason = "soon" | "unconfirmed" | "stale" | "manual" | "news";

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
  /** R9 news sweep: every festival starting within this many days (ongoing ones too), nothing else. */
  sweepWithin?: number;
}

export const SOON_DAYS = 180;
export const STALE_DAYS = 30;
export const STALE_DAYS_NEAR = 14;
export const NEAR_DAYS = 120;
export const DEFAULT_MAX = 40;
export const DEFAULT_PER_COUNTRY = 10;
/** Wider follow-up searches per weekly run (MAX_FOLLOWUPS_PER_RUN): each costs about one more festival. */
export const DEFAULT_MAX_FOLLOWUPS = 6;

const TIER_ORDER: Record<string, number> = { "1": 0, "2": 1, provisional: 2, hidden: 3 };

/** Days of the month that count as its first week: the slot for the monthly check (R10). */
export const MONTHLY_SLOT_DAYS = 7;

export function monthlySlot(today: ISO): boolean {
  return Number(today.slice(8, 10)) <= MONTHLY_SLOT_DAYS;
}

/**
 * R10 cadence. An edition without confirmed dates is checked every week from 180 days out and in
 * the first week of the month before that. A confirmed one only when its verification is stale
 * (14 days under 120 days out, 30 otherwise): the news sweeps (R9) watch its last 45 days.
 */
export function reasonsFor(daysToStart: number, status: string, lastVerified: ISO | null, today: ISO, monthly = monthlySlot(today)): QueueReason[] {
  const reasons: QueueReason[] = [];
  const confirmed = status === "confirmada";
  const soon = daysToStart < SOON_DAYS;
  if (!confirmed && soon) reasons.push("soon");
  if (!confirmed && (soon || monthly)) reasons.push("unconfirmed");
  const limit = daysToStart < NEAR_DAYS ? STALE_DAYS_NEAR : STALE_DAYS;
  if (confirmed && (!lastVerified || diffDays(lastVerified, today) > limit)) reasons.push("stale");
  return reasons;
}

export function compareItems(a: QueueItem, b: QueueItem): number {
  const days = a.daysToStart === b.daysToStart ? 0 : a.daysToStart < b.daysToStart ? -1 : 1;
  return days || (TIER_ORDER[String(a.tier)] ?? 9) - (TIER_ORDER[String(b.tier)] ?? 9) || a.country.localeCompare(b.country) || a.slug.localeCompare(b.slug);
}

/** R9: the sweep looks at editions that start within `within` days or are under way. */
export function inSweep(daysToStart: number, within: number): boolean {
  return Number.isFinite(daysToStart) && daysToStart <= within;
}

/**
 * Candidates for one country, before ordering and caps. `force` (from --only) skips the entry rules.
 * A postponed edition without new dates is not under way: the weekly run looks for its new dates,
 * the sweep would search for a cancellation every day forever.
 */
export function candidates(country: CountryFile, config: ScoringConfig, today: ISO, force?: string, sweepWithin?: number, monthly = monthlySlot(today)): QueueItem[] {
  return buildEntries(country, config, today).flatMap((entry) => {
    const occ = entry.occurrence;
    const daysToStart = occ ? diffDays(today, effectiveStart(occ)) : Number.POSITIVE_INFINITY;
    const status = occ?.status ?? "por_anunciar";
    const lastVerified = occ?.edition?.last_verified ?? null;
    const swept = sweepWithin !== undefined && inSweep(daysToStart, sweepWithin) && !(occ && isPendingPostponement(occ));
    const rules: QueueReason[] = sweepWithin === undefined ? reasonsFor(daysToStart, status, lastVerified, today, monthly) : swept ? ["news"] : [];
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

/**
 * Ordered by days to start then tier, max `perCountry` per country and `max` overall. A run for one
 * country (`--country`, only manual dispatches pass it) always gets the monthly checks too.
 */
export function buildQueue(countries: readonly CountryFile[], config: ScoringConfig, today: ISO, opts: QueueOptions): QueueItem[] {
  const wanted = opts.country?.toUpperCase();
  const monthly = wanted !== undefined || monthlySlot(today);
  const all = countries
    .filter((c) => !wanted || c.country === wanted)
    .flatMap((c) => candidates(c, config, today, opts.only, opts.sweepWithin, monthly))
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
