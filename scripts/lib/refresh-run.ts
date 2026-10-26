// Weekly verification run (H4, RF-15): queue → research → extraction → validation → PR files.
// Without --dry-run it also applies accepted changes; it never merges anything.
import { join } from "node:path";
import { ctxFor } from "../../src/festivals.ts";
import { ChangelogEntry, Proposal, type CountryFile } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";
import { loadCountries } from "../build-data.ts";
import { applyChanges, changelogEntries } from "./apply.ts";
import { archiveAll, type Archiver } from "./archive.ts";
import { allowedAtLevel, BudgetExceededError, createBudgetGuard, type BudgetGuard, type UsageStore } from "./budget.ts";
import { classifyApiError, type MessagesTransport } from "./client.ts";
import { firstPassDomains, loadDomainPolicy, type DomainPolicy } from "./domains.ts";
import { extract } from "./extract.ts";
import { extractionContext, researchUserPrompt } from "./festival-context.ts";
import { appendGithubOutput, loadPrompt, readJson, readJsonOr, writeJson, writeText, type Logger } from "./io.ts";
import { buildQueue, type QueueItem } from "./queue.ts";
import { buildRefreshReport, renderRefreshMarkdown, type FestivalLog, type RefreshReport } from "./report.ts";
import { research } from "./research.ts";
import { dataChangeCount, selectForPr } from "./select.ts";
import { fingerprint, makeTrap } from "./trap.ts";
import { reviewProposal, type ReviewedChange } from "./validate.ts";

export interface RefreshOptions {
  root: string;
  dryRun: boolean;
  today: string;
  model: string;
  only?: string;
  country?: string;
  maxFestivals: number;
  perCountry: number;
  budgetUsd: number;
  trapSecret?: string;
  githubOutput?: string;
}

export interface RefreshDeps {
  transport: MessagesTransport;
  archiver: Archiver;
  usage: UsageStore;
  log: Logger;
}

export interface RefreshResult {
  exitCode: number;
  report: RefreshReport | null;
  files: string[];
  calls: number;
}

export const MAX_USES = 5;

interface FestivalRun {
  log: FestivalLog;
  changes: ReviewedChange[];
  notFound: string[];
}

function baseLog(item: QueueItem): FestivalLog {
  return {
    country: item.country,
    slug: item.slug,
    year: item.year,
    tier: String(item.tier),
    days_to_start: Number.isFinite(item.daysToStart) ? item.daysToStart : null,
    reasons: item.reasons,
    outcome: "not_run",
  };
}

async function verifyFestival(item: QueueItem, country: CountryFile, policy: DomainPolicy, opts: RefreshOptions, deps: RefreshDeps, guard: BudgetGuard): Promise<FestivalRun> {
  const log = baseLog(item);
  const key = `${item.country}/${item.slug}`;
  const result = await research(deps.transport, guard, {
    key,
    model: opts.model,
    system: loadPrompt("research-system.md"),
    user: researchUserPrompt(item, country),
    country: item.country,
    timezone: item.festival.timezone,
    maxUses: MAX_USES,
    allowedDomains: firstPassDomains(policy),
    blockedDomains: policy.blocked,
  });
  const searched = { ...log, pass: result.pass, citations: result.citations.length, ...(result.searchErrors.length ? { search_errors: result.searchErrors } : {}) };
  if (result.outcome !== "ok") {
    const detail = result.outcome === "refusal" ? `refusal${result.refusalCategory ? `: ${result.refusalCategory}` : ""}` : String(result.stopReason);
    deps.log.info(`${key}: research ${result.outcome} (${detail})`);
    return { log: { ...searched, outcome: result.outcome, detail }, changes: [], notFound: [] };
  }
  const extracted = await extract(deps.transport, guard, {
    key,
    model: opts.model,
    system: loadPrompt("extract-system.md"),
    context: extractionContext(item),
    citedClaims: result.citedClaims,
    citations: result.citations,
    schema: Proposal,
  });
  if (!extracted.ok) {
    deps.log.warn(`${key}: extraction dropped after ${extracted.attempts} attempt(s): ${extracted.reason} ${extracted.detail}`);
    return { log: { ...searched, outcome: extracted.reason === "refusal" ? "refusal" : "invalid_proposal", detail: extracted.detail }, changes: [], notFound: [] };
  }
  const review = reviewProposal(extracted.value, {
    country: item.country,
    festival: item.festival,
    tier: item.tier,
    year: item.year,
    daysToStart: Number.isFinite(item.daysToStart) ? item.daysToStart : 9999,
    citations: result.citations,
    policy,
    ruleCtx: ctxFor(country),
  });
  if (review.errors.length) {
    deps.log.warn(`${key}: proposal rejected: ${review.errors.join("; ")}`);
    return { log: { ...searched, outcome: "invalid_proposal", detail: review.errors.join("; ") }, changes: [], notFound: review.notFound };
  }
  return { log: { ...searched, outcome: "ok" }, changes: review.changes, notFound: review.notFound };
}

function readChangelog(path: string): ChangelogEntry[] {
  return ChangelogEntry.array().parse(readJsonOr(path, []));
}

export async function runRefresh(opts: RefreshOptions, deps: RefreshDeps): Promise<RefreshResult> {
  const config = readJson(join(opts.root, "config", "scoring.json")) as ScoringConfig;
  const countries = loadCountries(join(opts.root, "data", "countries"));
  if (opts.only && !countries.some((c) => c.festivals.some((f) => f.slug === opts.only))) {
    deps.log.error(`--only=${opts.only}: no festival with that slug`);
    return { exitCode: 1, report: null, files: [], calls: 0 };
  }
  const queue = buildQueue(countries, config, opts.today, { max: opts.maxFestivals, perCountry: opts.perCountry, only: opts.only, country: opts.country });
  const month = opts.today.slice(0, 7);
  const guard = createBudgetGuard({ month, budgetUsd: opts.budgetUsd, model: opts.model, store: deps.usage, log: deps.log });
  const policies = new Map(countries.map((c) => [c.country, loadDomainPolicy(opts.root, c.country)]));
  deps.log.info(`refresh ${opts.today}: ${queue.length} festival(s) queued${opts.dryRun ? " (dry run)" : ""}`);

  const logs: FestivalLog[] = [];
  const changes: ReviewedChange[] = [];
  const notFound: RefreshReport["not_found"] = [];
  let stopped: string | null = null;
  let fatal = false;
  for (const item of queue) {
    if (stopped) {
      logs.push(baseLog(item));
      continue;
    }
    // The last call may have crossed the cap: stop here (non-zero exit), not as a silent skip.
    if (guard.level() === "stopped") {
      stopped = new BudgetExceededError(guard.current().usd, opts.budgetUsd, month).message;
      deps.log.error(stopped);
      logs.push({ ...baseLog(item), outcome: "skipped_budget", detail: "R10: budget reached" });
      continue;
    }
    if (!allowedAtLevel(guard.level(), item.tier, item.daysToStart)) {
      logs.push({ ...baseLog(item), outcome: "skipped_budget", detail: "R10: 80% of the monthly budget" });
      continue;
    }
    const country = countries.find((c) => c.country === item.country)!;
    try {
      const run = await verifyFestival(item, country, policies.get(item.country)!, opts, deps, guard);
      logs.push(run.log);
      changes.push(...run.changes);
      if (run.notFound.length) notFound.push({ country: item.country, slug: item.slug, fields: run.notFound });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stopped = error.message;
        deps.log.error(error.message);
        logs.push({ ...baseLog(item), outcome: "skipped_budget", detail: "R10: budget reached" });
        continue;
      }
      const failure = classifyApiError(error);
      logs.push({ ...baseLog(item), outcome: failure.kind === "fixture" ? "no_fixture" : "api_error", detail: failure.message });
      deps.log.warn(`${item.country}/${item.slug}: ${failure.kind}: ${failure.message}`);
      if (failure.kind === "fatal") {
        stopped = `API credentials rejected: ${failure.message}`;
        fatal = true;
      }
    }
  }

  // R12 trap: first run of the month, only when it can blend in with real changes and its
  // fingerprint has somewhere to go ($GITHUB_OUTPUT). Never written to the repo.
  const realChanges = changes.filter((c) => c.verdict === "accepted" && c.kind === "change").length;
  const trap = opts.trapSecret && guard.firstRunOfMonth && opts.githubOutput && !stopped && realChanges > 0
    ? makeTrap({ secret: opts.trapSecret, month, today: opts.today, countries, config, policies })
    : null;
  if (opts.trapSecret && guard.firstRunOfMonth && !trap) deps.log.info("R12: no trap this run (needs $GITHUB_OUTPUT, a real change and a dated upcoming edition)");

  const selection = selectForPr(changes, trap);
  const usage = guard.current();
  const report = buildRefreshReport(
    {
      date: opts.today,
      model: opts.model,
      dry_run: opts.dryRun,
      stopped,
      budget: { month, usd: usage.usd, budget_usd: opts.budgetUsd, level: guard.level(), searches: usage.searches },
      festivals: logs,
      not_found: notFound,
    },
    selection,
  );
  const exitCode = stopped || fatal ? 1 : 0;
  const count = dataChangeCount(selection);
  const output = { changes: stopped ? 0 : count, branch: `refresh/${opts.today}`, flagged: selection.flagged.length };
  if (count === 0 && selection.flagged.length === 0) {
    deps.log.info(`refresh ${opts.today}: no changes (${selection.rejected.length} rejected); nothing written`);
    appendGithubOutput(opts.githubOutput, output);
    return { exitCode, report, files: [], calls: guard.calls };
  }

  const files = writeProposals(opts.root, `${opts.today}`, report);
  if (!opts.dryRun && !stopped) {
    files.push(...(await applyRun(opts, deps, countries, [...selection.applied, ...selection.confirmations])));
  }
  appendGithubOutput(opts.githubOutput, { ...output, ...(trap ? { trap_fingerprint: fingerprint(opts.trapSecret!, trap) } : {}) });
  deps.log.info(`refresh ${opts.today}: ${selection.applied.length} change(s), ${selection.confirmations.length} confirmation(s), ${selection.flagged.length} to review, ${selection.rejected.length} rejected`);
  return { exitCode, report, files, calls: guard.calls };
}

export function writeProposals(root: string, name: string, report: RefreshReport | Record<string, unknown>, markdown?: string): string[] {
  const json = join(root, "proposals", `${name}.json`);
  const md = join(root, "proposals", `${name}.md`);
  writeJson(json, report);
  writeText(md, markdown ?? renderRefreshMarkdown(report as RefreshReport));
  return [json, md];
}

async function applyRun(opts: RefreshOptions, deps: RefreshDeps, countries: readonly CountryFile[], accepted: readonly ReviewedChange[]): Promise<string[]> {
  const archived = await archiveAll(deps.archiver, accepted.flatMap((c) => c.sources.map((s) => s.url)));
  const files: string[] = [];
  for (const country of countries) {
    const next = applyChanges(country, accepted, opts.today, archived);
    if (next === country) continue;
    const path = join(opts.root, "data", "countries", `${country.country.toLowerCase()}.json`);
    writeJson(path, next);
    files.push(path);
  }
  const entries = changelogEntries(accepted, opts.today);
  if (entries.length) {
    const path = join(opts.root, "data", "changelog.json");
    writeJson(path, [...readChangelog(path), ...entries]);
    files.push(path);
  }
  return files;
}
