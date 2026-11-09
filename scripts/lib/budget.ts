// Monthly spend control (R10, LLM10). Every call is checked before it is sent and recorded after,
// so a run that crosses the cap stops before the next call, not at the end of a festival. Each
// recorded call is one line of the ledger (ledger.ts), tagged with the job it was for.
import type { CallContext } from "./client.ts";
import type { Logger } from "./io.ts";
import { appendLedger, emptyMonth, monthsOf, readLedger, type Job, type LedgerEntry, type UsageMonth } from "./ledger.ts";
import type { CallGate, CallUsage } from "./research.ts";

export { emptyMonth, type UsageMonth };

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

export function addUsage(m: UsageMonth, usage: CallUsage, model: string): UsageMonth {
  return {
    month: m.month,
    searches: m.searches + usage.searches,
    input_tokens: m.input_tokens + usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    output_tokens: m.output_tokens + usage.output_tokens,
    usd: Math.round((m.usd + costOf(usage, model)) * 1_000_000) / 1_000_000,
  };
}

/** One ledger line for a call that returned. */
export function entryFor(day: string, job: Job, ctx: CallContext, usage: CallUsage, model: string): LedgerEntry {
  return {
    day,
    job,
    key: ctx.key,
    call: ctx.kind,
    model,
    searches: usage.searches,
    input_tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    output_tokens: usage.output_tokens,
    usd: Math.round(costOf(usage, model) * 1_000_000) / 1_000_000,
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
  /** Spend on record per month. */
  load(): UsageMonth[];
  /** One call that returned; persisted at once, so a crash never loses spend. */
  record(entry: LedgerEntry): void;
}

export interface BudgetGuard extends CallGate {
  level(): BudgetLevel;
  current(): UsageMonth;
  /** The same guard, recording its calls as `job` (a follow-up search inside a verification run). */
  as(job: Job): CallGate;
  calls: number;
}

export interface BudgetOptions {
  month: string;
  budgetUsd: number;
  model: string;
  store: UsageStore;
  log: Logger;
  /** Day written on each ledger line; the first of the month when absent. */
  today?: string;
  /** What the calls are for, unless a caller asks for another job with `as`. Default `verify`. */
  job?: Job;
}

/** Loads the month, warns once at 50% and 80%, throws before a call at 100%, records each call. */
export function createBudgetGuard(opts: BudgetOptions): BudgetGuard {
  const existing = opts.store.load().find((m) => m.month === opts.month);
  let current = existing ?? emptyMonth(opts.month);
  const day = opts.today ?? `${opts.month}-01`;
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
  const beforeCall = (_ctx: CallContext): void => {
    if (levelOf(current.usd, opts.budgetUsd) === "stopped") throw new BudgetExceededError(current.usd, opts.budgetUsd, opts.month);
  };
  const afterCall = (job: Job) => (ctx: CallContext, usage: CallUsage): void => {
    guard.calls += 1;
    current = addUsage(current, usage, opts.model);
    opts.store.record(entryFor(day, job, ctx, usage, opts.model));
    warn();
  };
  const guard: BudgetGuard = {
    calls: 0,
    level: () => levelOf(current.usd, opts.budgetUsd),
    current: () => current,
    beforeCall,
    afterCall: afterCall(opts.job ?? "verify"),
    as: (job) => ({ beforeCall, afterCall: afterCall(job) }),
  };
  return guard;
}

/** R10 degradation: at 80% only tier-1 festivals that start within 60 days keep being verified. */
export function allowedAtLevel(level: BudgetLevel, tier: unknown, daysToStart: number): boolean {
  if (level === "stopped") return false;
  if (level === "degraded80") return tier === 1 && daysToStart <= 60;
  return true;
}

/**
 * In memory: recorded runs (fixtures) cost nothing real, and tests read what would be written.
 * `saved` holds the month totals after each call, `entries` the ledger lines.
 */
export function memoryUsageStore(initial: readonly UsageMonth[] = []): UsageStore & { saved: UsageMonth[][]; entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  const saved: UsageMonth[][] = [];
  const months = (): UsageMonth[] => {
    const added = new Map(monthsOf(entries).map((m) => [m.month, m]));
    const merged = initial.map((m) => {
      const a = added.get(m.month);
      added.delete(m.month);
      return a ? { month: m.month, searches: m.searches + a.searches, input_tokens: m.input_tokens + a.input_tokens, output_tokens: m.output_tokens + a.output_tokens, usd: Math.round((m.usd + a.usd) * 1_000_000) / 1_000_000 } : m;
    });
    return [...merged, ...added.values()].sort((a, b) => a.month.localeCompare(b.month));
  };
  return {
    saved,
    entries,
    load: months,
    record(entry) {
      entries.push(entry);
      saved.push(months());
    },
  };
}

/** data/state/ledger.jsonl: a missing file is an empty history; every call appends one line. */
export function ledgerUsageStore(path: string): UsageStore {
  return {
    load: () => monthsOf(readLedger(path)),
    record: (entry) => appendLedger(path, [entry]),
  };
}
