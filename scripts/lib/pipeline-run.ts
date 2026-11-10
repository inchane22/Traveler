// The daily pipeline (pipeline.yml): intake → publish ready drafts → plan → news sweeps → builds →
// verification → holds → state files and a summary. Accepted changes are applied by the checks
// alone; pipeline.yml commits the result straight to main and the site deploys once CI is green.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ISO } from "../../src/dates.ts";
import { CountryFile } from "../../src/schema.ts";
import { isParty, type ScoringConfig } from "../../src/score.ts";
import { ISO_COUNTRIES } from "../../src/search.ts";
import { loadCountries } from "../build-data.ts";
import type { Archiver } from "./archive.ts";
import { BudgetExceededError, createBudgetGuard, levelOf, type UsageStore } from "./budget.ts";
import type { MessagesTransport } from "./client.ts";
import { loadDomainPolicy, tierOf, type DomainPolicy } from "./domains.ts";
import { mergeHolds, readHolds, renderHolds, writeHolds } from "./holds.ts";
import { appendGithubOutput, readJson, writeJson, writeText, type Logger } from "./io.ts";
import { countryInfo } from "./lang.ts";
import { monthsOf, type LedgerEntry } from "./ledger.ts";
import type { LinkVerdict } from "./links.ts";
import { mdText } from "./markdown.ts";
import { runOnboard } from "./onboard-run.ts";
import { makePlan, type Plan, type PipelineSettings, type PlannedBuild } from "./plan.ts";
import { promoteReady, readiness } from "./publish.ts";
import { candidates, classifyCandidates, compareItems, type QueueItem } from "./queue.ts";
import { runRefresh, type RefreshOptions } from "./refresh-run.ts";
import type { RefreshReport } from "./report.ts";
import { fieldLabel } from "./report.ts";
import { nextRequest, readRequests, upsertRequest, writeRequests, type CountryRequest, type RequestEvent } from "./requests.ts";
import { draftSourcePolicy, hasPolicyFiles } from "./source-policy.ts";
import type { ReviewedChange } from "./validate.ts";

export interface PipelineOptions {
  root: string;
  today: ISO;
  model: string;
  budgetUsd: number;
  maxFestivals: number;
  maxFollowups: number;
  /** Plan only: no API call; only the summary is written. */
  planOnly: boolean;
  /** A country someone asked for (a «build-country» issue or a manual run). */
  request?: { country: string; issue?: number };
  links?: ReadonlyMap<string, LinkVerdict>;
  /** Public site, for the link in the issue comment when a country goes live. */
  siteUrl?: string;
  githubOutput?: string;
}

export interface PipelineDeps {
  transport: MessagesTransport;
  archiver: Archiver;
  usage: UsageStore;
  /** Every ledger line so far, this run's included. */
  ledger: () => LedgerEntry[];
  log: Logger;
}

export type BuildOutcome = "live" | "retry" | "gave_up" | "error";

export interface BuildLog {
  country: string;
  outcome: BuildOutcome;
  sourced: number;
  needed: number;
  detail?: string;
}

export interface IssueUpdate {
  issue: number;
  comment: string;
  close: boolean;
}

export interface PipelineSummary {
  kind: "pipeline";
  date: ISO;
  plan_only: boolean;
  intake: { country: string; accepted: boolean; reason?: string } | null;
  published: string[];
  builds: BuildLog[];
  applied: ReviewedChange[];
  confirmations: number;
  flagged: ReviewedChange[];
  rejected: number;
  unexpected: number;
  stopped: string[];
  spend: { month: string; before: number; after: number; budget: number };
  holds: number;
  issues: IssueUpdate[];
}

export interface PipelineResult {
  exitCode: number;
  plan: Plan;
  summary: PipelineSummary;
  files: string[];
}

export const PipelineSettingsFile = {
  read(root: string): PipelineSettings {
    return readJson(join(root, "config", "pipeline.json")) as PipelineSettings;
  },
};

function monthSpend(usage: UsageStore, month: string): number {
  return usage.load().find((m) => m.month === month)?.usd ?? 0;
}

/** True when a dated edition of the festival rests on an A or B source (what R2 counts). */
function isSourced(f: CountryFile["festivals"][number], policy: DomainPolicy): boolean {
  return Object.values(f.editions).some((e) => !!e.start && !!e.end && e.sources.some((s) => tierOf(s.url, policy) !== "C"));
}

/** Festivals of a draft without a sourced date yet, nearest first: what a build researches. */
export function topUpQueue(country: CountryFile, config: ScoringConfig, policy: DomainPolicy, today: ISO, max: number): QueueItem[] {
  return candidates(country, config, today, undefined, undefined, true)
    .filter((item) => !isSourced(item.festival, policy))
    .sort(compareItems)
    .slice(0, max);
}

function countryPath(root: string, cc: string): string {
  return join(root, "data", "countries", `${cc.toLowerCase()}.json`);
}

function readCountry(root: string, cc: string): CountryFile | null {
  const path = countryPath(root, cc);
  return existsSync(path) ? CountryFile.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}

function policiesFor(root: string, countries: readonly CountryFile[]): Map<string, DomainPolicy> {
  return new Map(countries.map((c) => [c.country, loadDomainPolicy(root, c.country)]));
}

/** Writes every draft that now passes as «publicado»; returns their codes. */
export function publishReady(root: string, today: ISO, log: Logger): string[] {
  const countries = loadCountries(join(root, "data", "countries"));
  const { countries: next, promoted } = promoteReady(countries, policiesFor(root, countries), today);
  for (const c of next) {
    if (!promoted.includes(c.country)) continue;
    writeJson(countryPath(root, c.country), CountryFile.parse(c));
    log.info(`publish ${c.country}: passes the R2 gate; now «publicado»`);
  }
  return promoted;
}

/** A two-letter code the site knows and the pipeline has country facts for. */
export function intakeProblem(code: string): string | null {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return `«${code.slice(0, 20)}» is not a two-letter ISO 3166-1 code`;
  if (!ISO_COUNTRIES.includes(cc)) return `${cc} is not a country code the site knows`;
  if (!countryInfo(cc)) return `no country facts for ${cc} (scripts/lib/lang.ts)`;
  return null;
}

interface RunContext {
  opts: PipelineOptions;
  deps: PipelineDeps;
  settings: PipelineSettings;
  config: ScoringConfig;
  reports: RefreshReport[];
  stopped: string[];
  exitCodes: number[];
}

async function refreshBatch(ctx: RunContext, queue: readonly QueueItem[], extra: Partial<RefreshOptions> & { reportName: string }): Promise<void> {
  if (!queue.length) return;
  const { opts, deps } = ctx;
  const result = await runRefresh(
    {
      root: opts.root,
      dryRun: false,
      today: opts.today,
      model: opts.model,
      maxFestivals: queue.length,
      perCountry: queue.length,
      budgetUsd: opts.budgetUsd,
      queue,
      ...extra,
    },
    { transport: deps.transport, archiver: deps.archiver, usage: deps.usage, log: deps.log },
  );
  if (result.report) {
    ctx.reports.push(result.report);
    if (result.report.stopped) ctx.stopped.push(result.report.stopped);
  }
  ctx.exitCodes.push(result.exitCode);
}

/** Policy (if none), onboarding (if no file), then the date top-up; publishes when the gate passes. */
async function buildCountry(ctx: RunContext, b: PlannedBuild): Promise<{ log: BuildLog; event: RequestEvent }> {
  const { opts, deps, settings, config } = ctx;
  const cc = b.country;
  const month = opts.today.slice(0, 7);
  const info = countryInfo(cc);
  const error = (detail: string) => ({ log: { country: cc, outcome: "error" as const, sourced: 0, needed: 3, detail }, event: { type: "error" as const, today: opts.today, note: detail } });
  if (!info) return error("no country facts");
  const overBudget = () => levelOf(monthSpend(deps.usage, month), opts.budgetUsd) === "stopped";

  if (!hasPolicyFiles(opts.root, cc)) {
    const gate = createBudgetGuard({ month, today: opts.today, budgetUsd: opts.budgetUsd, model: opts.model, store: deps.usage, log: deps.log, job: "policy" });
    try {
      await draftSourcePolicy(deps.transport, gate, { root: opts.root, country: cc, countryName: info.names.en, localLanguage: info.local, model: opts.model }, deps.log);
    } catch (e) {
      if (e instanceof BudgetExceededError) return error(e.message);
      throw e;
    }
  }

  if (!readCountry(opts.root, cc)) {
    const onboarded = await runOnboard(
      { root: opts.root, country: cc, dryRun: false, today: opts.today, model: opts.model, budgetUsd: opts.budgetUsd },
      { transport: deps.transport, usage: deps.usage, log: deps.log, archiver: deps.archiver },
    );
    if (onboarded.exitCode !== 0 || !readCountry(opts.root, cc)) {
      if (overBudget()) return error("R10: monthly budget reached during onboarding");
      const detail = "onboarding found no festival that passed validation";
      return { log: { country: cc, outcome: "retry", sourced: 0, needed: 3, detail }, event: { type: "built", today: opts.today, published: false, note: detail } };
    }
  }

  // Classify first, so a solemn act is not researched for dates it will never be listed with.
  const unclassified = classifyCandidates(readCountry(opts.root, cc)!, config, opts.today).slice(0, settings.build_topups);
  await refreshBatch(ctx, unclassified, { classify: true, job: "build", reportName: `build-${cc.toLowerCase()}-classify-${opts.today}` });
  if (overBudget() && ctx.stopped.length) return error("R10: monthly budget reached during the build");

  const draft = readCountry(opts.root, cc)!;
  const policy = loadDomainPolicy(opts.root, cc);
  const queue = topUpQueue(draft, config, policy, opts.today, settings.build_topups);
  await refreshBatch(ctx, queue, { job: "build", maxFollowups: queue.length, reportName: `build-${cc.toLowerCase()}-${opts.today}` });
  if (overBudget() && ctx.stopped.length) return error("R10: monthly budget reached during the build");

  const after = readCountry(opts.root, cc)!;
  const ready = readiness(after, new Map([[cc, loadDomainPolicy(opts.root, cc)]]), opts.today);
  if (ready.ok && after.status === "borrador") {
    writeJson(countryPath(opts.root, cc), CountryFile.parse({ ...after, status: "publicado" }));
    deps.log.info(`build ${cc}: ${ready.sourced} sourced festival(s); now «publicado»`);
  }
  const live = ready.ok || after.status === "publicado";
  const detail = live ? undefined : `${ready.sourced} of ${ready.needed} festivals with a date on an A or B source${ready.problems.length && ready.sourced >= ready.needed ? `; ${ready.problems[0]}` : ""}`;
  return {
    log: { country: cc, outcome: live ? "live" : "retry", sourced: ready.sourced, needed: ready.needed, ...(detail ? { detail } : {}) },
    event: { type: "built", today: opts.today, published: live, ...(detail ? { note: detail } : {}) },
  };
}

function issueComment(req: CountryRequest, festivals: number, plan: Plan, siteUrl: string | undefined): IssueUpdate | null {
  if (!req.issue) return null;
  const name = countryInfo(req.country)?.names.en ?? req.country;
  switch (req.status) {
    case "live": {
      const link = siteUrl ? ` ${siteUrl.replace(/\/?$/, "/")}#/pais/${req.country.toLowerCase()}` : "";
      return { issue: req.issue, comment: `${name} is live with ${festivals} festivals.${link}`, close: true };
    }
    case "retry":
      return { issue: req.issue, comment: `Built ${name}, but it is not live yet: ${req.note ?? "not enough sourced dates"}. Next try on ${req.retry_after}.`, close: false };
    case "gave_up":
      return { issue: req.issue, comment: `Gave up on ${name} after ${req.attempts} tries (${req.note ?? "not enough sourced dates"}). Reopen this issue to try again.`, close: true };
    case "queued": {
      const wait = plan.waiting.find((w) => w.country === req.country);
      const when = wait?.reason === "budget" ? `This month's new-country budget is used; it starts on ${wait.until}.` : "It starts on the next run.";
      return { issue: req.issue, comment: `${name} is queued. ${when}${req.note ? ` (${req.note})` : ""}`, close: false };
    }
  }
}

function changeLine(c: ReviewedChange): string {
  const src = c.sources[0]?.url ?? "";
  return `- ${c.country} ${c.slug} ${c.year} ${fieldLabel(c.field)}: ${String(c.old ?? "—")} → ${String(c.new ?? "—")}${src ? ` (${src})` : ""}`;
}

/** First line under 72 characters; the body lists every change and source (git log is the audit trail). */
export function commitMessage(s: PipelineSummary): string {
  const bits = [`${s.applied.length} applied`, ...(s.flagged.length ? [`${s.flagged.length} held`] : []), ...s.builds.filter((b) => b.outcome === "live").map((b) => `${b.country} live`), ...s.published.map((c) => `${c} live`)];
  const head = `chore(data): pipeline ${s.date} · ${bits.join(" · ")}`.slice(0, 100);
  const body: string[] = [];
  if (s.applied.length) body.push("Applied by the checks (no human review):", ...s.applied.map(changeLine));
  if (s.confirmations) body.push(`Confirmed: ${s.confirmations} field(s) re-verified.`);
  if (s.flagged.length) body.push("Held (data/state/holds.json):", ...s.flagged.map(changeLine));
  if (s.builds.length) body.push("Builds:", ...s.builds.map((b) => `- ${b.country}: ${b.outcome} (${b.sourced}/${b.needed} sourced)${b.detail ? `: ${b.detail}` : ""}`));
  if (s.published.length) body.push(`Published on their own: ${s.published.join(", ")}.`);
  body.push(`Spend ${s.spend.month}: US$${s.spend.after.toFixed(2)} of US$${s.spend.budget.toFixed(2)} (this run US$${(s.spend.after - s.spend.before).toFixed(2)}).`);
  return `${head}\n\n${body.join("\n")}\n`;
}

/** Run summary for $GITHUB_STEP_SUMMARY and proposals/pipeline-<date>.md. */
export function renderSummary(plan: Plan, s: PipelineSummary): string {
  const b = plan.budget;
  const lines = [
    `## Pipeline ${s.date}${s.plan_only ? " (plan only)" : ""}`,
    b.released
      ? `Budget ${plan.month}: US$${(b.spentUpkeep + b.spentBuild).toFixed(2)} spent before this run of US$${b.total.toFixed(2)} (upkeep US$${b.spentUpkeep.toFixed(2)}, new countries US$${b.spentBuild.toFixed(2)}). Last days of the month: both share the US$${b.upkeepLeft.toFixed(2)} left, upkeep first. Today's upkeep share: US$${b.todayUpkeep.toFixed(2)} over ${b.daysLeft} day(s) left.`
      : `Budget ${plan.month}: US$${(b.spentUpkeep + b.spentBuild).toFixed(2)} spent before this run of US$${b.total.toFixed(2)}; upkeep US$${b.spentUpkeep.toFixed(2)} of US$${b.upkeepPool.toFixed(2)}, new countries US$${b.spentBuild.toFixed(2)} of US$${b.buildPool.toFixed(2)}. Today's upkeep share: US$${b.todayUpkeep.toFixed(2)} over ${b.daysLeft} day(s) left.`,
    `Cost per job used: ${Object.entries(plan.costs).map(([k, v]) => `${k} US$${v.toFixed(2)}`).join(", ")}.`,
    `Planned: ${plan.sweep.length} news sweep(s), ${plan.classify.length} classification(s), ${plan.verify.length} verification(s), ${plan.builds.length} build(s)${plan.deferred.length ? `; ${plan.deferred.length} due festival(s) wait for another day` : ""}.`,
    plan.waiting.length ? `Waiting: ${plan.waiting.map((w) => `${w.country} (${w.reason === "budget" ? `budget, from ${w.until}` : "next run"})`).join(", ")}.` : "",
    `Projection: about US$${plan.projection.perCountry.toFixed(2)} a month to keep one country fresh at full cadence; the upkeep share covers ${plan.projection.countriesSupported ?? "any number of"} countries that way.${plan.projection.stretch > 1 ? ` Checks more than 45 days out run ${plan.projection.stretch}× less often to fit the budget.` : ""}`,
  ];
  if (!s.plan_only) {
    if (s.intake) lines.push(`Request: ${s.intake.country} ${s.intake.accepted ? "accepted" : `refused (${mdText(s.intake.reason, 120)})`}.`);
    if (s.published.length) lines.push(`Published on their own: ${s.published.join(", ")}.`);
    for (const build of s.builds) lines.push(`Build ${build.country}: ${build.outcome}, ${build.sourced}/${build.needed} sourced${build.detail ? ` (${mdText(build.detail, 200)})` : ""}.`);
    lines.push(`Changes: ${s.applied.length} applied, ${s.confirmations} confirmed, ${s.flagged.length} held, ${s.rejected} rejected${s.unexpected ? `, ${s.unexpected} festival(s) failed with an unexpected error` : ""}.`);
    if (s.stopped.length) lines.push(`Stopped: ${mdText(s.stopped[0], 200)}`);
    lines.push(`Spend this run: US$${(s.spend.after - s.spend.before).toFixed(2)}; month total US$${s.spend.after.toFixed(2)}.`);
  }
  return `${lines.filter(Boolean).join("\n\n")}\n`;
}

export async function runPipeline(opts: PipelineOptions, deps: PipelineDeps): Promise<PipelineResult> {
  const settings = PipelineSettingsFile.read(opts.root);
  const config = readJson(join(opts.root, "config", "scoring.json")) as ScoringConfig;
  const rules = { maxAttempts: settings.max_build_attempts, retryDays: settings.retry_days };
  const month = opts.today.slice(0, 7);
  const spentBefore = monthSpend(deps.usage, month);
  let requests = readRequests(opts.root);
  const statusBefore = new Map(requests.map((r) => [r.country, r.status]));
  const touched = new Set<string>();
  const apply = (cc: string, event: RequestEvent): void => {
    requests = upsertRequest(requests, nextRequest(requests.find((r) => r.country === cc), cc, event, rules));
    touched.add(cc);
  };

  // 1. Intake.
  let intake: PipelineSummary["intake"] = null;
  const invalidIssues: IssueUpdate[] = [];
  if (opts.request) {
    const cc = opts.request.country.trim().toUpperCase();
    const problem = intakeProblem(cc);
    intake = problem ? { country: cc.slice(0, 2), accepted: false, reason: problem } : { country: cc, accepted: true };
    if (problem) {
      deps.log.warn(`request: ${problem}`);
      if (opts.request.issue) invalidIssues.push({ issue: opts.request.issue, comment: `Could not queue this: ${problem}. Use the two-letter ISO code, for example JP.`, close: true });
    } else {
      apply(cc, { type: "request", today: opts.today, ...(opts.request.issue ? { issue: opts.request.issue } : {}) });
    }
  }

  // 2. Drafts that already pass go live, and requests for live countries are marked so.
  const published = opts.planOnly ? [] : publishReady(opts.root, opts.today, deps.log);
  const live = new Set(loadCountries(join(opts.root, "data", "countries")).filter((c) => c.status === "publicado").map((c) => c.country));
  for (const r of requests) if (live.has(r.country) && r.status !== "live") apply(r.country, { type: "published", today: opts.today });

  // 3. Plan.
  const countries = loadCountries(join(opts.root, "data", "countries"));
  const configured = new Set([...countries.map((c) => c.country), ...requests.map((r) => r.country)].filter((cc) => hasPolicyFiles(opts.root, cc)));
  const plan = makePlan({ today: opts.today, budgetUsd: opts.budgetUsd, settings, countries, config, requests, ledger: deps.ledger(), configured, maxFestivals: opts.maxFestivals });
  for (const d of plan.deferred) deps.log.info(`plan: ${d.country}/${d.slug} (${d.band}) waits for another day`);

  const ctx: RunContext = { opts, deps, settings, config, reports: [], stopped: [], exitCodes: [] };
  const builds: BuildLog[] = [];
  if (!opts.planOnly) {
    // 4. News sweeps, classification, 5. builds, 6. verification.
    await refreshBatch(ctx, plan.sweep, { sweepWithin: 45, reportName: `sweep-${opts.today}` });
    await refreshBatch(ctx, plan.classify, { classify: true, job: "classify", reportName: `classify-${opts.today}` });
    for (const b of plan.builds) {
      const { log, event } = await buildCountry(ctx, b);
      builds.push(log);
      apply(b.country, event);
      if (log.outcome === "error" && /budget/i.test(log.detail ?? "")) break;
    }
    // A festival the classification just found to be a solemn act is no longer listed: no dates to check.
    const solemn = new Set(loadCountries(join(opts.root, "data", "countries")).flatMap((c) => c.festivals.filter((f) => !isParty(f.score)).map((f) => `${c.country}/${f.slug}`)));
    const verify = plan.verify.filter((i) => !solemn.has(`${i.country}/${i.slug}`));
    await refreshBatch(ctx, verify, { job: "verify", maxFollowups: opts.maxFollowups, reportName: `verify-${opts.today}`, ...(opts.links ? { links: opts.links } : {}) });
    published.push(...publishReady(opts.root, opts.today, deps.log));
    for (const cc of published) if (requests.some((r) => r.country === cc)) apply(cc, { type: "published", today: opts.today });
  }

  // 7. Holds and state.
  const applied = ctx.reports.flatMap((r) => r.applied);
  const confirmations = ctx.reports.flatMap((r) => r.confirmations);
  const flagged = ctx.reports.flatMap((r) => r.flagged);
  const holds = mergeHolds(readHolds(opts.root), flagged, [...applied, ...confirmations], opts.today);
  const files: string[] = [];
  if (!opts.planOnly) {
    writeHolds(opts.root, holds);
    writeRequests(opts.root, requests);
  }

  const festivalsOf = (cc: string): number => readCountry(opts.root, cc)?.festivals.length ?? 0;
  const issues = [
    ...invalidIssues,
    ...requests
      .filter((r) => touched.has(r.country) && (r.status !== statusBefore.get(r.country) || r.country === intake?.country))
      .map((r) => issueComment(r, festivalsOf(r.country), plan, opts.siteUrl))
      .filter((u): u is IssueUpdate => u !== null),
  ];
  const summary: PipelineSummary = {
    kind: "pipeline",
    date: opts.today,
    plan_only: opts.planOnly,
    intake,
    published: [...new Set(published)],
    builds,
    applied,
    confirmations: confirmations.length,
    flagged,
    rejected: ctx.reports.reduce((n, r) => n + r.rejected.length, 0),
    unexpected: ctx.reports.reduce((n, r) => n + r.festivals.filter((f) => f.outcome === "error").length, 0),
    stopped: ctx.stopped,
    spend: { month, before: spentBefore, after: monthSpend(deps.usage, month), budget: opts.budgetUsd },
    holds: holds.length,
    issues,
  };

  const dir = join(opts.root, "proposals");
  const name = `pipeline-${opts.today}`;
  const keys = (items: readonly QueueItem[]) => items.map((i) => `${i.country}/${i.slug}`);
  writeJson(join(dir, `${name}.json`), { ...summary, plan: { ...plan, sweep: keys(plan.sweep), classify: keys(plan.classify), verify: keys(plan.verify) } });
  writeText(join(dir, `${name}.md`), renderSummary(plan, summary));
  writeText(join(dir, "commit-message.txt"), commitMessage(summary));
  writeText(join(dir, "holds.md"), renderHolds(holds, opts.today));
  writeJson(join(dir, "issue-updates.json"), issues);
  files.push(...[`${name}.json`, `${name}.md`, "commit-message.txt", "holds.md", "issue-updates.json"].map((f) => join(dir, f)));

  // BE-04: an unexpected error in one festival does not stop the others, but the run goes red.
  const exitCode = ctx.exitCodes.some((c) => c !== 0) || summary.unexpected > 0 ? 1 : 0;
  appendGithubOutput(opts.githubOutput, {
    changes: applied.length + confirmations.length,
    held: flagged.length,
    unexpected: summary.unexpected,
    builds: builds.length,
    stopped: ctx.stopped.length ? "true" : "false",
  });
  deps.log.info(`pipeline ${opts.today}: ${applied.length} applied, ${flagged.length} held, ${builds.length} build(s), ${summary.published.length} published; month spend US$${summary.spend.after.toFixed(2)} of US$${opts.budgetUsd}`);
  return { exitCode, plan, summary, files };
}

/** Months on record, for the CLI's opening line. */
export function spendLine(entries: readonly LedgerEntry[], month: string, budget: number): string {
  const m = monthsOf(entries).find((x) => x.month === month);
  return `R10: US$${(m?.usd ?? 0).toFixed(2)} of US$${budget.toFixed(2)} spent in ${month}`;
}
