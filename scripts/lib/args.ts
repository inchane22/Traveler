// CLI flags and env vars fixed by docs/architecture.md «Pipeline CLI». Pure: argv and env in, options out.
import { todayIn } from "../../src/dates.ts";
import { ISODate } from "../../src/schema.ts";
import { DEFAULT_BUDGET_USD } from "./budget.ts";
import { modelFromEnv } from "./client.ts";
import { NEWS_SWEEP_DAYS } from "./lang.ts";
import { DEFAULT_MAX, DEFAULT_MAX_FOLLOWUPS, DEFAULT_PER_COUNTRY } from "./queue.ts";
import { countryFromIssue } from "./requests.ts";

export interface CommonOptions {
  dryRun: boolean;
  today: string;
  fixtures: string | null;
  model: string;
  budgetUsd: number;
  githubOutput: string | undefined;
}

export interface RefreshArgs extends CommonOptions {
  only?: string;
  country?: string;
  maxFestivals: number;
  perCountry: number;
  /** R9 news sweep (`--sweep=news`): only festivals starting within this many days. */
  sweepWithin?: number;
  /** Wider follow-up searches for missing dates (weekly run only); 0 turns them off. */
  maxFollowups: number;
  /** `--classify`: is each festival a party, and where its crowd comes from (unclassified ones). */
  classify: boolean;
}

export interface OnboardArgs extends CommonOptions {
  country: string;
}

export interface PipelineArgs extends CommonOptions {
  /** `--plan`: print today's plan and write the summary, without any API call. */
  planOnly: boolean;
  request?: { country: string; issue?: number };
  maxFestivals: number;
  maxFollowups: number;
  siteUrl?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const KNOWN = new Set(["dry-run", "only", "country", "today", "fixtures", "proposals", "verbose", "sweep", "within", "plan", "request", "issue", "classify"]);

export function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (arg === "--") continue;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !KNOWN.has(m[1]!)) throw new UsageError(`unknown argument: ${arg}`);
    flags.set(m[1]!, m[2] ?? true);
  }
  return flags;
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value (--${name}=…)`);
  return v?.trim() || undefined;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer, got ${raw}`);
  return n;
}

function nonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be 0 or a positive integer, got ${raw}`);
  return n;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} must be a positive number, got ${raw}`);
  return n;
}

function common(flags: Map<string, string | true>, env: NodeJS.ProcessEnv, now: Date): CommonOptions {
  const today = str(flags, "today") ?? todayIn("UTC", now);
  if (!ISODate.safeParse(today).success) throw new UsageError(`--today must be YYYY-MM-DD, got ${today}`);
  return {
    dryRun: flags.get("dry-run") === true,
    today,
    fixtures: str(flags, "fixtures") ?? null,
    model: modelFromEnv(env),
    budgetUsd: positiveNumber(env.MONTHLY_BUDGET_USD, DEFAULT_BUDGET_USD, "MONTHLY_BUDGET_USD"),
    githubOutput: env.GITHUB_OUTPUT?.trim() || undefined,
  };
}

export function refreshArgs(argv: readonly string[], env: NodeJS.ProcessEnv, now = new Date()): RefreshArgs {
  const flags = parseFlags(argv);
  const only = str(flags, "only");
  const country = str(flags, "country")?.toUpperCase();
  if (only && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(only)) throw new UsageError(`--only must be a festival slug, got ${only}`);
  if (country && !/^[A-Z]{2}$/.test(country)) throw new UsageError(`--country must be an ISO 3166-1 alpha-2 code, got ${country}`);
  const sweepWithin = sweepDays(flags);
  const classify = flags.get("classify") === true;
  if (flags.has("classify") && !classify) throw new UsageError("--classify takes no value");
  if (classify && sweepWithin !== undefined) throw new UsageError("--classify and --sweep=news are separate runs");
  return {
    ...common(flags, env, now),
    ...(only ? { only } : {}),
    ...(country ? { country } : {}),
    ...(sweepWithin !== undefined ? { sweepWithin } : {}),
    maxFestivals: positiveInt(env.MAX_FESTIVALS_PER_RUN, DEFAULT_MAX, "MAX_FESTIVALS_PER_RUN"),
    perCountry: DEFAULT_PER_COUNTRY,
    maxFollowups: nonNegativeInt(env.MAX_FOLLOWUPS_PER_RUN, DEFAULT_MAX_FOLLOWUPS, "MAX_FOLLOWUPS_PER_RUN"),
    classify,
  };
}

/** `--sweep=news [--within=<days>]`: days from 1 to 45 (R9 cadence), 45 by default. */
function sweepDays(flags: Map<string, string | true>): number | undefined {
  const sweep = str(flags, "sweep");
  const within = str(flags, "within");
  if (sweep === undefined) {
    if (within !== undefined) throw new UsageError("--within only applies to --sweep=news");
    return undefined;
  }
  if (sweep !== "news") throw new UsageError(`--sweep must be "news", got ${sweep}`);
  const days = positiveInt(within, NEWS_SWEEP_DAYS, "--within");
  if (days > NEWS_SWEEP_DAYS) throw new UsageError(`--within must be ${NEWS_SWEEP_DAYS} days or less, got ${days}`);
  return days;
}

export function onboardArgs(argv: readonly string[], env: NodeJS.ProcessEnv, now = new Date()): OnboardArgs {
  const flags = parseFlags(argv);
  const country = str(flags, "country")?.toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) throw new UsageError("--country=<cc> is required (ISO 3166-1 alpha-2)");
  return { ...common(flags, env, now), country };
}

/**
 * `pnpm pipeline -- [--plan] [--request=<cc> [--issue=<n>]] [--today=…] [--fixtures=<dir>]`. From
 * an issue event the workflow passes ISSUE_NUMBER, ISSUE_TITLE and ISSUE_BODY as env vars (never
 * on the command line), and the country is read from them here. `--request` wins when both are set.
 */
export function pipelineArgs(argv: readonly string[], env: NodeJS.ProcessEnv, now = new Date()): PipelineArgs {
  const flags = parseFlags(argv);
  const base = common(flags, env, now);
  const issueRaw = str(flags, "issue") ?? env.ISSUE_NUMBER?.trim();
  const issue = issueRaw ? positiveInt(issueRaw, 0, "--issue") : undefined;
  const fromFlag = str(flags, "request")?.toUpperCase();
  const fromIssue = env.ISSUE_TITLE !== undefined || env.ISSUE_BODY !== undefined ? countryFromIssue(env.ISSUE_TITLE ?? "", env.ISSUE_BODY ?? "") : null;
  // An issue that names no country is still a request: intake refuses it and says why on the issue.
  const country = fromFlag ?? fromIssue ?? (issue !== undefined ? "??" : undefined);
  if (fromFlag && !/^[A-Z]{2}$/.test(fromFlag)) throw new UsageError(`--request must be an ISO 3166-1 alpha-2 code, got ${fromFlag}`);
  const site = env.SITE_URL?.trim();
  return {
    ...base,
    planOnly: flags.get("plan") === true || base.dryRun,
    ...(country ? { request: { country, ...(issue !== undefined ? { issue } : {}) } } : {}),
    maxFestivals: positiveInt(env.MAX_FESTIVALS_PER_RUN, DEFAULT_MAX, "MAX_FESTIVALS_PER_RUN"),
    maxFollowups: nonNegativeInt(env.MAX_FOLLOWUPS_PER_RUN, DEFAULT_MAX_FOLLOWUPS, "MAX_FOLLOWUPS_PER_RUN"),
    ...(site && /^https:\/\//.test(site) ? { siteUrl: site } : {}),
  };
}
