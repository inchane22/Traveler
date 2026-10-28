// Monthly spend control (R10, LLM10). Every call is checked before it is sent and recorded after,
// so a run that crosses the cap stops before the next call, not at the end of a festival.
import { z } from "zod";
import type { CallContext } from "./client.ts";
import type { Logger } from "./io.ts";
import type { CallGate, CallUsage } from "./research.ts";

/** USD per million tokens. Web search is billed per search on top (US$10 per 1,000). */
export const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
export const SEARCH_USD = 0.01;
/** Prompt-cache multipliers on the input price. */
export const CACHE_WRITE = 1.25;
export const CACHE_READ = 0.1;
export const DEFAULT_BUDGET_USD = 20;

export const UsageMonth = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    searches: z.number().int().min(0),
    /** All input tokens, cached ones included. */
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    usd: z.number().min(0),
    /**
     * Weekly verifications that spent this month; news sweeps and onboarding leave it alone, so
     * the R12 trap still goes in the first weekly PR. A record without it counts as one done.
     */
    weekly_runs: z.number().int().min(0).optional(),
  })
  .strict();
export const UsageFile = z.array(UsageMonth);
export type UsageMonth = z.infer<typeof UsageMonth>;

export function priceFor(model: string): { input: number; output: number } {
  const price = PRICES[model];
  // Unknown models are priced at the most expensive known rate rather than as free.
  return price ?? { input: 4, output: 20 };
}

export function costOf(usage: CallUsage, model: string): number {
  const p = priceFor(model);
  const input = usage.input_tokens + usage.cache_creation_input_tokens * CACHE_WRITE + usage.cache_read_input_tokens * CACHE_READ;
  return usage.searches * SEARCH_USD + (input * p.input + usage.output_tokens * p.output) / 1_000_000;
}

export function emptyMonth(month: string): UsageMonth {
  return { month, searches: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
}

export function addUsage(m: UsageMonth, usage: CallUsage, model: string): UsageMonth {
  return {
    month: m.month,
    searches: m.searches + usage.searches,
    input_tokens: m.input_tokens + usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    output_tokens: m.output_tokens + usage.output_tokens,
    usd: Math.round((m.usd + costOf(usage, model)) * 1_000_000) / 1_000_000,
    ...(m.weekly_runs !== undefined ? { weekly_runs: m.weekly_runs } : {}),
  };
}

export type BudgetLevel = "ok" | "warn50" | "degraded80" | "stopped";

export function levelOf(usd: number, budget: number): BudgetLevel {
  if (budget <= 0 || usd >= budget) return "stopped";
  if (usd >= budget * 0.8) return "degraded80";
  if (usd >= budget * 0.5) return "warn50";
  return "ok";
}

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number, month: string) {
    super(`R10: monthly budget reached (US$${spent.toFixed(2)} of US$${budget.toFixed(2)} in ${month}); stopping before the next API call`);
    this.name = "BudgetExceededError";
  }
}

export interface UsageStore {
  load(): UsageMonth[];
  save(months: UsageMonth[]): void;
}

export interface BudgetGuard extends CallGate {
  level(): BudgetLevel;
  current(): UsageMonth;
  /** True for the first weekly run of the month (sweeps and onboarding never are): drives the R12 trap. */
  firstRunOfMonth: boolean;
  calls: number;
}

export interface BudgetOptions {
  month: string;
  budgetUsd: number;
  model: string;
  store: UsageStore;
  log: Logger;
  /** False for news sweeps and onboarding: they spend from the budget but are not the weekly run. Default true. */
  weekly?: boolean;
}

/** Loads the month, warns once at 50% and 80%, throws before a call at 100%, persists after each call. */
export function createBudgetGuard(opts: BudgetOptions): BudgetGuard {
  let months = UsageFile.parse(opts.store.load());
  const existing = months.find((m) => m.month === opts.month);
  let current = existing ?? emptyMonth(opts.month);
  const weekly = opts.weekly ?? true;
  const weeklyBefore = existing ? (existing.weekly_runs ?? 1) : 0;
  const warned = new Set<BudgetLevel>();
  const warn = (): void => {
    const level = levelOf(current.usd, opts.budgetUsd);
    const pct = Math.round((current.usd / opts.budgetUsd) * 100);
    if ((level === "warn50" || level === "degraded80") && !warned.has("warn50")) {
      warned.add("warn50");
      opts.log.warn(`R10: ${pct}% of MONTHLY_BUDGET_USD used (US$${current.usd.toFixed(2)} of US$${opts.budgetUsd})`);
    }
    if (level === "degraded80" && !warned.has("degraded80")) {
      warned.add("degraded80");
      opts.log.warn("R10: 80% reached; only tier-1 festivals starting within 60 days are verified for the rest of the month");
    }
  };
  warn();
  const guard: BudgetGuard = {
    firstRunOfMonth: weekly && weeklyBefore === 0,
    calls: 0,
    level: () => levelOf(current.usd, opts.budgetUsd),
    current: () => current,
    beforeCall(_ctx: CallContext) {
      if (levelOf(current.usd, opts.budgetUsd) === "stopped") throw new BudgetExceededError(current.usd, opts.budgetUsd, opts.month);
    },
    afterCall(_ctx: CallContext, usage: CallUsage) {
      guard.calls += 1;
      current = { ...addUsage(current, usage, opts.model), weekly_runs: weeklyBefore + (weekly ? 1 : 0) };
      months = [...months.filter((m) => m.month !== opts.month), current].sort((a, b) => a.month.localeCompare(b.month));
      opts.store.save(months);
      warn();
    },
  };
  return guard;
}

/** R10 degradation: at 80% only tier-1 festivals that start within 60 days keep being verified. */
export function allowedAtLevel(level: BudgetLevel, tier: unknown, daysToStart: number): boolean {
  if (level === "stopped") return false;
  if (level === "degraded80") return tier === 1 && daysToStart <= 60;
  return true;
}

export function memoryUsageStore(initial: UsageMonth[] = []): UsageStore & { saved: UsageMonth[][] } {
  let data = initial;
  const saved: UsageMonth[][] = [];
  return {
    saved,
    load: () => data,
    save: (months) => {
      data = months;
      saved.push(months);
    },
  };
}

/**
 * Usage persistence across unmerged PRs: per month, the record with the higher spend wins. Both
 * sides are running totals of the same month (the artifact of the last run started from main's
 * file plus every fallback before it), so the max never undercounts what was really spent.
 */
export function mergeUsage(primary: readonly UsageMonth[], fallback: readonly UsageMonth[]): UsageMonth[] {
  const byMonth = new Map(primary.map((m) => [m.month, m]));
  for (const m of fallback) {
    const mine = byMonth.get(m.month);
    if (!mine || m.usd > mine.usd) byMonth.set(m.month, m);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * The usage.json of the latest run artifact, from USAGE_FALLBACK_PATH. Unset or missing means no
 * fallback; an unreadable file is logged and ignored (the Console spend limit stays the hard cap).
 */
export function readUsageFallback(path: string | undefined, io: { read: (p: string) => unknown; exists: (p: string) => boolean }, log: Logger): UsageMonth[] {
  const file = path?.trim();
  if (!file) return [];
  if (!io.exists(file)) {
    log.info(`R10: no usage fallback at ${file}; using data/usage.json only`);
    return [];
  }
  let raw: unknown;
  try {
    raw = io.read(file);
  } catch (error) {
    log.warn(`R10: usage fallback ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ignored`);
    return [];
  }
  const parsed = UsageFile.safeParse(raw);
  if (!parsed.success) {
    log.warn(`R10: usage fallback ${file} does not match the usage schema; ignored`);
    return [];
  }
  return parsed.data;
}

/**
 * A store that reads the max of `base` and `fallback`. With `persist`, the merged history is
 * written to `base` right away, so the file this run uploads never goes below the fallback.
 */
export function withUsageFallback(base: UsageStore, fallback: readonly UsageMonth[], opts: { persist: boolean; log: Logger }): UsageStore {
  if (!fallback.length) return base;
  const loaded = UsageFile.parse(base.load());
  const merged = mergeUsage(loaded, fallback);
  if (JSON.stringify(merged) !== JSON.stringify(loaded)) {
    opts.log.info("R10: usage fallback is ahead of data/usage.json (an unmerged PR or a run without PR); using the higher total");
    if (opts.persist) base.save(merged);
  }
  return {
    load: () => mergeUsage(UsageFile.parse(base.load()), fallback),
    save: (months) => base.save(months),
  };
}

/** data/usage.json on disk; a missing file is an empty history. */
export function fileUsageStore(path: string, io: { read: (p: string) => unknown; write: (p: string, v: unknown) => void; exists: (p: string) => boolean }): UsageStore {
  return {
    load: () => (io.exists(path) ? UsageFile.parse(io.read(path)) : []),
    save: (months) => io.write(path, months),
  };
}
