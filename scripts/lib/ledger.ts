// The spend record (R10): one line per Claude API call in data/state/ledger.jsonl, appended and
// never rewritten. Monthly totals, what each kind of job really costs and when a festival was last
// checked are all derived from it, so there is no second copy to keep in sync.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ISODate } from "../../src/schema.ts";

/**
 * What a call was for. `onboard` and `policy` start a new country, `build` classifies and tops up
 * its dates before it goes live; the others keep published countries fresh (`classify` decides
 * once whether a festival is a party and where its crowd comes from).
 */
export const Job = z.enum(["onboard", "policy", "build", "verify", "followup", "sweep", "classify"]);
export type Job = z.infer<typeof Job>;

/** Jobs paid from the share of the budget set aside for new countries. */
export const BUILD_JOBS: ReadonlySet<Job> = new Set(["onboard", "policy", "build"]);

export const LedgerEntry = z
  .object({
    day: ISODate,
    job: Job,
    /** `CO/carnaval-barranquilla` for a festival, `onboard/PE` or `policy/PE` for a country. */
    key: z.string().min(1),
    /** `carryover` is a total brought in from before the ledger existed. */
    call: z.enum(["research", "extract", "carryover"]),
    model: z.string().min(1),
    searches: z.number().int().min(0),
    /** All input tokens, cached ones included. */
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    usd: z.number().min(0),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export interface UsageMonth {
  month: string;
  searches: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

export const LEDGER_PATH = join("data", "state", "ledger.jsonl");

export function ledgerPath(root: string): string {
  return join(root, LEDGER_PATH);
}

/** One JSON object per line; blank lines are ignored, anything else that does not parse throws. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${i + 1} is not JSON`);
    }
    const parsed = LedgerEntry.safeParse(raw);
    if (!parsed.success) throw new Error(`ledger line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    out.push(parsed.data);
  });
  return out;
}

export function readLedger(path: string): LedgerEntry[] {
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : [];
}

export function appendLedger(path: string, entries: readonly LedgerEntry[]): void {
  if (!entries.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, entries.map((e) => `${JSON.stringify(LedgerEntry.parse(e))}\n`).join(""));
}

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function emptyMonth(month: string): UsageMonth {
  return { month, searches: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
}

/** Running totals per month, oldest first. */
export function monthsOf(entries: readonly LedgerEntry[]): UsageMonth[] {
  const byMonth = new Map<string, UsageMonth>();
  for (const e of entries) {
    const month = e.day.slice(0, 7);
    const m = byMonth.get(month) ?? emptyMonth(month);
    byMonth.set(month, {
      month,
      searches: m.searches + e.searches,
      input_tokens: m.input_tokens + e.input_tokens,
      output_tokens: m.output_tokens + e.output_tokens,
      usd: round(m.usd + e.usd),
    });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** What a month's entries spent on new countries and on keeping the others fresh. */
export function spendByPool(entries: readonly LedgerEntry[], month: string): { build: number; upkeep: number } {
  let build = 0;
  let upkeep = 0;
  for (const e of entries) {
    if (!e.day.startsWith(month)) continue;
    if (BUILD_JOBS.has(e.job)) build += e.usd;
    else upkeep += e.usd;
  }
  return { build: round(build), upkeep: round(upkeep) };
}

/**
 * Average cost of one job of a kind. A job is every call of that kind for one key on one day (a
 * festival's research, its extraction and any continuation); carry-over totals are left out.
 */
export function averageJobCost(entries: readonly LedgerEntry[], job: Job): { jobs: number; usd: number } {
  const groups = new Map<string, number>();
  for (const e of entries) {
    if (e.job !== job || e.call === "carryover") continue;
    const id = `${e.day}|${e.key}`;
    groups.set(id, (groups.get(id) ?? 0) + e.usd);
  }
  const total = [...groups.values()].reduce((a, b) => a + b, 0);
  return { jobs: groups.size, usd: groups.size ? round(total / groups.size) : 0 };
}

/** Last day each key was worked on by one of `jobs`. */
export function lastDays(entries: readonly LedgerEntry[], jobs: ReadonlySet<Job>): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!jobs.has(e.job) || e.call === "carryover") continue;
    const prev = out.get(e.key);
    if (!prev || e.day > prev) out.set(e.key, e.day);
  }
  return out;
}
