// What today's run does, within the money (R10). Pure: countries, requests, the ledger, today and
// the budget in; the festivals to check, the news sweeps and the countries to build out.
//
// Cadence by closeness: how often a festival is checked depends on how soon its next edition is
// and whether a source has settled it; the last check comes from the ledger, so a check that found
// nothing still counts and is not repeated tomorrow. The money: a share of the month is set aside
// for new countries; upkeep gets the rest, spread evenly over the days left, highest priority
// first. Whatever does not fit today is simply still due tomorrow.
import { addMonths, diffDays, effectiveStart, type ISO } from "../../src/dates.ts";
import { buildEntries, isPendingPostponement } from "../../src/festivals.ts";
import type { CountryFile } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";
import { STATUS_TRAITS } from "../../src/status.ts";
import { averageJobCost, lastDays, spendByPool, type Job, type LedgerEntry } from "./ledger.ts";
import { needsClassifying, type QueueItem } from "./queue.ts";
import { requestsDue, type CountryRequest } from "./requests.ts";

export interface PipelineSettings {
  /** Share of the monthly budget set aside for building new countries. */
  new_country_share: number;
  /** In the month's last days, what the new-country share did not use goes to upkeep. */
  release_build_pool_days: number;
  max_builds_per_run: number;
  /** Festivals researched while building one country, before it goes live. */
  build_topups: number;
  max_build_attempts: number;
  retry_days: number;
  /** What a job costs until the ledger has real numbers. */
  default_job_usd: Record<Job, number>;
}

export type Band = "sweep-7" | "classify" | "verify-45" | "sweep-45" | "verify-120" | "verify-180" | "verify-far";

/**
 * Priority order; builds sit between `sweep-45` and `verify-120` (their own money). Classifying
 * comes right after the last-week sweeps: it decides whether a festival is listed at all.
 */
export const BANDS: readonly Band[] = ["sweep-7", "classify", "verify-45", "sweep-45", "verify-120", "verify-180", "verify-far"];

/** Days before an unclassified festival is asked about again after a classification that found nothing. */
export const CLASSIFY_RETRY_DAYS = 30;

/** Most the planner stretches the far-away cadence when the upkeep money is short. */
export const MAX_STRETCH = 4;

/**
 * Days between checks of an edition. Close and unsettled is checked most (dates come out in the
 * last weeks); settled or far away much less; tier 2 and below half as often beyond 45 days.
 * `stretch` (1 to MAX_STRETCH) lengthens everything beyond 45 days when money is short; the last
 * 45 days never stretch.
 */
export function verifyInterval(daysToStart: number, settled: boolean, tier: unknown = 1, stretch = 1): number {
  let days: number;
  if (settled) days = daysToStart < 120 ? 30 : 90;
  else if (daysToStart <= 45) days = 7;
  else if (daysToStart <= 120) days = 14;
  else if (daysToStart <= 180) days = 30;
  else days = 60;
  if (daysToStart <= 45) return days;
  return Math.round(days * (tier === 1 ? 1 : 2) * Math.min(Math.max(stretch, 1), MAX_STRETCH));
}

/** News sweeps (R9) only in the last 45 days: weekly, then every day (tier 1) or two in the last week. */
export function sweepInterval(daysToStart: number, tier: unknown = 1): number | null {
  if (!Number.isFinite(daysToStart) || daysToStart > 45) return null;
  if (daysToStart <= 7) return tier === 1 ? 1 : 2;
  return 7;
}

function verifyBand(daysToStart: number): Band {
  if (daysToStart <= 45) return "verify-45";
  if (daysToStart <= 120) return "verify-120";
  if (daysToStart <= 180) return "verify-180";
  return "verify-far";
}

export interface PlannedItem {
  item: QueueItem;
  band: Band;
  cost: number;
}

export interface PlannedBuild {
  country: string;
  /** The country file exists already (a draft), so only its dates are topped up. */
  hasFile: boolean;
  /** No config/sources yet: the build drafts the source policy first. */
  needsPolicy: boolean;
  estimate: number;
}

export interface PlanBudget {
  total: number;
  /** Monthly pools; in the last days (`released`) both are the whole budget, shared. */
  upkeepPool: number;
  buildPool: number;
  spentUpkeep: number;
  spentBuild: number;
  upkeepLeft: number;
  buildLeft: number;
  daysLeft: number;
  /** What upkeep may spend today. */
  todayUpkeep: number;
  released: boolean;
}

export interface Plan {
  today: ISO;
  month: string;
  budget: PlanBudget;
  costs: Record<Job, number>;
  sweep: QueueItem[];
  /** Festivals of live countries still unclassified (is it a party, where its crowd comes from). */
  classify: QueueItem[];
  verify: QueueItem[];
  builds: PlannedBuild[];
  waiting: Array<{ country: string; reason: "budget" | "per_run_limit"; estimate: number; until: ISO }>;
  /** Due today but over today's share; still due tomorrow. */
  deferred: Array<{ country: string; slug: string; band: Band }>;
  /**
   * Full-cadence upkeep for the live countries, and the stretch applied beyond 45 days so it fits
   * the upkeep share (1 = full cadence, MAX_STRETCH = the most it slows down).
   */
  projection: { monthlyUpkeep: number; perCountry: number; countriesSupported: number | null; stretch: number };
}

export interface PlanInput {
  today: ISO;
  budgetUsd: number;
  settings: PipelineSettings;
  countries: readonly CountryFile[];
  config: ScoringConfig;
  requests: readonly CountryRequest[];
  ledger: readonly LedgerEntry[];
  /** Countries with config/sources (or official domains) written. */
  configured: ReadonlySet<string>;
  /** Cap on festivals verified in one run (MAX_FESTIVALS_PER_RUN). */
  maxFestivals: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Per job: the ledger's average once it has three jobs of that kind, the default before. */
export function jobCosts(ledger: readonly LedgerEntry[], defaults: Record<Job, number>): Record<Job, number> {
  const out = { ...defaults };
  for (const job of Object.keys(defaults) as Job[]) {
    const avg = averageJobCost(ledger, job);
    if (avg.jobs >= 3) out[job] = avg.usd;
  }
  return out;
}

function daysInMonth(today: ISO): number {
  const first = `${today.slice(0, 7)}-01`;
  return diffDays(first, addMonths(first, 1));
}

export function budgetFor(input: Pick<PlanInput, "today" | "budgetUsd" | "settings" | "ledger">): PlanBudget {
  const month = input.today.slice(0, 7);
  const spent = spendByPool(input.ledger, month);
  const daysLeft = daysInMonth(input.today) - Number(input.today.slice(8, 10)) + 1;
  const share = Math.min(Math.max(input.settings.new_country_share, 0), 1);
  // Whatever is left of the month; a pool that overran its share eats into it (the guard caps the month).
  const overall = Math.max(0, input.budgetUsd - spent.upkeep - spent.build);
  const released = daysLeft <= input.settings.release_build_pool_days;
  if (released) {
    // Last days: upkeep and new countries share what is left; upkeep is planned first (makePlan).
    return {
      total: input.budgetUsd,
      upkeepPool: input.budgetUsd,
      buildPool: input.budgetUsd,
      spentUpkeep: spent.upkeep,
      spentBuild: spent.build,
      upkeepLeft: round2(overall),
      buildLeft: round2(overall),
      daysLeft,
      todayUpkeep: round2(overall / daysLeft),
      released,
    };
  }
  const buildPool = input.budgetUsd * share;
  const upkeepPool = input.budgetUsd - buildPool;
  const upkeepLeft = Math.min(Math.max(0, upkeepPool - spent.upkeep), overall);
  return {
    total: input.budgetUsd,
    upkeepPool: round2(upkeepPool),
    buildPool: round2(buildPool),
    spentUpkeep: spent.upkeep,
    spentBuild: spent.build,
    upkeepLeft: round2(upkeepLeft),
    buildLeft: round2(Math.min(Math.max(0, buildPool - spent.build), overall)),
    daysLeft,
    todayUpkeep: round2(upkeepLeft / daysLeft),
    released,
  };
}

interface Due {
  item: QueueItem;
  band: Band;
  kind: "verify" | "sweep" | "classify";
}

/** Festivals of published countries that are due today, with their band. */
export function dueToday(countries: readonly CountryFile[], config: ScoringConfig, ledger: readonly LedgerEntry[], today: ISO, stretch = 1): Due[] {
  const checked = lastDays(ledger, new Set<Job>(["verify", "followup", "build"]));
  const swept = lastDays(ledger, new Set<Job>(["sweep"]));
  const classified = lastDays(ledger, new Set<Job>(["classify"]));
  const since = (day: string | null | undefined): number => (day ? diffDays(day, today) : Number.POSITIVE_INFINITY);
  const out: Due[] = [];
  for (const country of countries) {
    if (country.status !== "publicado") continue;
    for (const entry of buildEntries(country, config, today)) {
      const occ = entry.occurrence;
      const key = `${country.country}/${entry.festival.slug}`;
      const daysToStart = occ ? diffDays(today, effectiveStart(occ)) : Number.POSITIVE_INFINITY;
      const status = occ?.status ?? "por_anunciar";
      const lastVerified = occ?.edition?.last_verified ?? null;
      const lastCheck = [lastVerified, checked.get(key)].filter((d): d is string => !!d).sort().at(-1) ?? null;
      const item: QueueItem = {
        country: country.country,
        slug: entry.festival.slug,
        festival: entry.festival,
        tier: entry.score.tier,
        year: occ?.year ?? Number(today.slice(0, 4)) + 1,
        occurrence: occ,
        daysToStart,
        lastVerified,
        reasons: [],
      };
      if (needsClassifying(entry.festival) && since(classified.get(key)) >= CLASSIFY_RETRY_DAYS) {
        out.push({ item: { ...item, reasons: ["unclassified"] }, band: "classify", kind: "classify" });
      }
      const settled = STATUS_TRAITS[status].settled;
      if (since(lastCheck) >= verifyInterval(daysToStart, settled, entry.score.tier, stretch)) {
        out.push({ item: { ...item, reasons: settled ? ["stale"] : daysToStart < 180 ? ["soon", "unconfirmed"] : ["unconfirmed"] }, band: verifyBand(daysToStart), kind: "verify" });
        continue;
      }
      // A verification near the date already looks for news (festival-context.ts), so it counts as a sweep.
      const every = sweepInterval(daysToStart, entry.score.tier);
      const sweepable = !occ || (STATUS_TRAITS[occ.status].takesPlace && !isPendingPostponement(occ));
      const lastLook = [lastCheck, swept.get(key)].filter((d): d is string => !!d).sort().at(-1) ?? null;
      if (every !== null && sweepable && since(lastLook) >= every) {
        out.push({ item: { ...item, reasons: ["news"] }, band: daysToStart <= 7 ? "sweep-7" : "sweep-45", kind: "sweep" });
      }
    }
  }
  const tierRank = (t: unknown): number => (t === 1 ? 0 : t === 2 ? 1 : 2);
  return out.sort(
    (a, b) =>
      BANDS.indexOf(a.band) - BANDS.indexOf(b.band) ||
      tierRank(a.item.tier) - tierRank(b.item.tier) ||
      a.item.daysToStart - b.item.daysToStart ||
      `${a.item.country}/${a.item.slug}`.localeCompare(`${b.item.country}/${b.item.slug}`),
  );
}

/** Checks a festival gets in 30 days at a given stretch, sweeps included. */
function checksPerMonth(daysToStart: number, settled: boolean, tier: unknown, stretch: number): { verify: number; sweep: number } {
  const verify = 30 / verifyInterval(daysToStart, settled, tier, stretch);
  const every = sweepInterval(daysToStart, tier);
  // Inside the window: weekly sweeps, plus daily (or every other day) in the last week.
  const sweep = every === null ? 0 : daysToStart <= 7 ? 7 / every : 30 / every;
  return { verify, sweep };
}

/** A verification costs its own job plus, now and then, a follow-up search for missing dates. */
export const verifyCost = (costs: Record<Job, number>): number => costs.verify + costs.followup * 0.3;

export function monthlyUpkeep(countries: readonly CountryFile[], config: ScoringConfig, costs: Record<Job, number>, today: ISO, stretch: number): number {
  let monthly = 0;
  for (const country of countries) {
    if (country.status !== "publicado") continue;
    for (const entry of buildEntries(country, config, today)) {
      const occ = entry.occurrence;
      const daysToStart = occ ? diffDays(today, effectiveStart(occ)) : Number.POSITIVE_INFINITY;
      const n = checksPerMonth(daysToStart, STATUS_TRAITS[occ?.status ?? "por_anunciar"].settled, entry.score.tier, stretch);
      monthly += n.verify * verifyCost(costs) + n.sweep * costs.sweep;
    }
  }
  return monthly;
}

/** Full-cadence cost, and the smallest stretch (in quarter steps) that fits the upkeep share. */
export function projection(countries: readonly CountryFile[], config: ScoringConfig, costs: Record<Job, number>, today: ISO, upkeepPool: number): Plan["projection"] {
  const live = countries.filter((c) => c.status === "publicado").length;
  const full = monthlyUpkeep(countries, config, costs, today, 1);
  let stretch = 1;
  while (stretch < MAX_STRETCH && monthlyUpkeep(countries, config, costs, today, stretch) > upkeepPool) stretch += 0.25;
  const perCountry = live ? full / live : 0;
  return { monthlyUpkeep: round2(full), perCountry: round2(perCountry), countriesSupported: perCountry > 0 ? Math.floor(upkeepPool / perCountry) : null, stretch };
}

/** A build: its source policy, the onboarding, then up to `build_topups` classifications and date top-ups. */
export function buildEstimate(costs: Record<Job, number>, settings: PipelineSettings, hasFile: boolean, needsPolicy: boolean): number {
  return round2((needsPolicy ? costs.policy : 0) + (hasFile ? 0 : costs.onboard) + settings.build_topups * (costs.build + costs.classify));
}

export function makePlan(input: PlanInput): Plan {
  const { today, settings } = input;
  const month = today.slice(0, 7);
  const costs = jobCosts(input.ledger, settings.default_job_usd);
  const budget = budgetFor(input);
  const nextMonth = addMonths(`${month}-01`, 1);

  // Upkeep: highest band first; the last-week sweeps go even past today's share while money is left.
  const proj = projection(input.countries, input.config, costs, today, budget.upkeepPool);
  let todayLeft = budget.todayUpkeep;
  let monthLeft = budget.upkeepLeft;
  const sweep: QueueItem[] = [];
  const classify: QueueItem[] = [];
  const verify: QueueItem[] = [];
  const deferred: Plan["deferred"] = [];
  const queues = { sweep, classify, verify };
  for (const due of dueToday(input.countries, input.config, input.ledger, today, proj.stretch)) {
    const cost = due.kind === "sweep" ? costs.sweep : due.kind === "classify" ? costs.classify : verifyCost(costs);
    const urgent = due.band === "sweep-7";
    const fits = cost <= monthLeft && (urgent || cost <= todayLeft) && (due.kind === "sweep" || queues[due.kind].length < input.maxFestivals);
    if (!fits) {
      deferred.push({ country: due.item.country, slug: due.item.slug, band: due.band });
      continue;
    }
    monthLeft -= cost;
    todayLeft -= cost;
    queues[due.kind].push(due.item);
  }

  // Builds: oldest request first, from the new-country share (in the last days, from what upkeep left).
  const byCode = new Map(input.countries.map((c) => [c.country, c]));
  let buildLeft = budget.released ? Math.max(0, budget.buildLeft - (budget.upkeepLeft - monthLeft)) : budget.buildLeft;
  const builds: PlannedBuild[] = [];
  const waiting: Plan["waiting"] = [];
  for (const req of requestsDue(input.requests, today)) {
    const file = byCode.get(req.country);
    if (file?.status === "publicado") continue; // the pipeline marks it live
    const hasFile = !!file;
    const needsPolicy = !input.configured.has(req.country);
    const estimate = buildEstimate(costs, settings, hasFile, needsPolicy);
    if (builds.length >= settings.max_builds_per_run) {
      waiting.push({ country: req.country, reason: "per_run_limit", estimate, until: today });
      continue;
    }
    if (estimate > buildLeft) {
      waiting.push({ country: req.country, reason: "budget", estimate, until: nextMonth });
      continue;
    }
    buildLeft -= estimate;
    builds.push({ country: req.country, hasFile, needsPolicy, estimate });
  }

  return {
    today,
    month,
    budget,
    costs,
    sweep,
    classify,
    verify,
    builds,
    waiting,
    deferred,
    projection: proj,
  };
}
