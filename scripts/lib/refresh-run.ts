// Weekly verification run (H4, RF-15): queue → research → extraction → validation → PR files.
// Without --dry-run it also applies accepted changes; it never merges anything.
import { join } from "node:path";
import { ctxFor } from "../../src/festivals.ts";
import { ChangelogEntry, CountryFile, MIN_SOURCED_FESTIVALS, Proposal } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";
import { STATUS_TRAITS } from "../../src/status.ts";
import { loadCountries, sourcedFestivals } from "../build-data.ts";
import { applyChanges, changelogEntries, trialApply } from "./apply.ts";
import { archiveAll, type Archiver } from "./archive.ts";
import { allowedAtLevel, BudgetExceededError, createBudgetGuard, type BudgetGuard, type UsageStore } from "./budget.ts";
import { classifyApiError, type MessagesTransport } from "./client.ts";
import { firstPassDomains, loadDomainPolicy, type DomainPolicy } from "./domains.ts";
import { extract } from "./extract.ts";
import { extractionContext, researchUserPrompt, type FollowupFact } from "./festival-context.ts";
import { appendGithubOutput, loadPrompt, readJson, readJsonOr, writeJson, writeText, type Logger } from "./io.ts";
import { applyLostSources, type LinkDowngrade, type LinkVerdict } from "./links.ts";
import { buildQueue, NEAR_DAYS, type QueueItem } from "./queue.ts";
import { buildRefreshReport, renderRefreshMarkdown, type DraftProgress, type FestivalLog, type FestivalOutcome, type FollowupLog, type RefreshReport } from "./report.ts";
import { research, researchPass, type ResearchRequest, type ResearchResult } from "./research.ts";
import { dataChangeCount, selectForPr, type Selection } from "./select.ts";
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
  /** R9 news sweep: only festivals starting within this many days; never carries the R12 trap. */
  sweepWithin?: number;
  /** R13: verdicts from a fresh check-links report; without it no source downgrade is made. */
  links?: ReadonlyMap<string, LinkVerdict>;
  /** Wider follow-up searches this run may spend (weekly run only); absent or 0 turns them off. */
  maxFollowups?: number;
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
const FOLLOWUP_FACTS: readonly FollowupFact[] = ["start", "end", "status"];

interface FestivalRun {
  log: FestivalLog;
  changes: ReviewedChange[];
  notFound: string[];
}

interface FollowupBudget {
  /** Spends one follow-up; false when none is left or the month is at 80% (R10). */
  take(): boolean;
}

/**
 * Date facts an edition a source has not settled still lacks after the first pass. That pass stops
 * at official sites, which often cite the festival without stating the next edition's dates. A
 * settled edition (confirmed, with its dates; or cancelled) has none to find (src/status.ts).
 */
export function missingDateFacts(item: QueueItem, changes: readonly ReviewedChange[]): FollowupFact[] {
  const e = item.festival.editions[String(item.year)];
  if (e && STATUS_TRAITS[e.status].settled) return [];
  const answered = new Set(changes.filter((c) => c.verdict !== "rejected").map((c) => c.field));
  if (answered.has("start") && answered.has("end")) return [];
  return FOLLOWUP_FACTS.filter((f) => !answered.has(f));
}

type Reviewed = { ok: true; changes: ReviewedChange[]; notFound: string[] } | { ok: false; outcome: FestivalOutcome; detail: string; warning: string; notFound: string[] };

async function extractAndReview(item: QueueItem, country: CountryFile, policy: DomainPolicy, citations: ResearchResult["citations"], opts: RefreshOptions, deps: RefreshDeps, guard: BudgetGuard): Promise<Reviewed> {
  const key = `${item.country}/${item.slug}`;
  const extracted = await extract(deps.transport, guard, {
    key,
    model: opts.model,
    system: loadPrompt("extract-system.md"),
    context: extractionContext(item),
    citations,
    schema: Proposal,
  });
  if (!extracted.ok) {
    const outcome = extracted.reason === "refusal" ? "refusal" : "invalid_proposal";
    return { ok: false, outcome, detail: extracted.detail, warning: `extraction dropped after ${extracted.attempts} attempt(s): ${extracted.reason} ${extracted.detail}`, notFound: [] };
  }
  const review = reviewProposal(extracted.value, {
    country: item.country,
    festival: item.festival,
    tier: item.tier,
    year: item.year,
    daysToStart: Number.isFinite(item.daysToStart) ? item.daysToStart : 9999,
    citations,
    policy,
    ruleCtx: ctxFor(country),
  });
  if (review.errors.length) {
    const detail = review.errors.join("; ");
    return { ok: false, outcome: "invalid_proposal", detail, warning: `proposal rejected: ${detail}`, notFound: review.notFound };
  }
  return { ok: true, changes: review.changes, notFound: review.notFound };
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

async function verifyFestival(item: QueueItem, country: CountryFile, policy: DomainPolicy, opts: RefreshOptions, deps: RefreshDeps, guard: BudgetGuard, followups: FollowupBudget): Promise<FestivalRun> {
  const log = baseLog(item);
  const key = `${item.country}/${item.slug}`;
  const request = (followup?: readonly FollowupFact[]): ResearchRequest => ({
    key,
    model: opts.model,
    system: loadPrompt("research-system.md"),
    user: researchUserPrompt(item, country, followup),
    country: item.country,
    timezone: item.festival.timezone,
    maxUses: MAX_USES,
    allowedDomains: firstPassDomains(policy),
    blockedDomains: policy.blocked,
  });
  const result = await research(deps.transport, guard, request());
  const searched = { ...log, pass: result.pass, citations: result.citations.length, ...(result.searchErrors.length ? { search_errors: result.searchErrors } : {}) };
  if (result.outcome !== "ok") {
    const detail = result.outcome === "refusal" ? `refusal${result.refusalCategory ? `: ${result.refusalCategory}` : ""}` : String(result.stopReason);
    deps.log.info(`${key}: research ${result.outcome} (${detail})`);
    return { log: { ...searched, outcome: result.outcome, detail }, changes: [], notFound: [] };
  }
  const first = await extractAndReview(item, country, policy, result.citations, opts, deps, guard);
  if (!first.ok) {
    deps.log.warn(`${key}: ${first.warning}`);
    return { log: { ...searched, outcome: first.outcome, detail: first.detail }, changes: [], notFound: first.notFound };
  }
  const run: FestivalRun = { log: { ...searched, outcome: "ok" }, changes: first.changes, notFound: first.notFound };
  // Only after a first pass restricted to official sites (an open pass already searched widely), and
  // only under 120 days out: further away nobody has published the dates yet (2026-11-08 run).
  const missing = result.pass === 1 && item.daysToStart < NEAR_DAYS ? missingDateFacts(item, first.changes) : [];
  if (!missing.length || !followups.take()) return run;
  return followUp(item, country, policy, request(missing), missing, run, opts, deps, guard);
}

/**
 * Second, open search (block list only) for the date facts the first pass did not state. Its
 * proposals go through the same validation against its own citations; only the missing facts are
 * kept, so the first pass always wins. An API failure or the budget here keeps the first pass's
 * results; rejected credentials and bugs fail the festival like a first-pass error (BE-04).
 */
async function followUp(item: QueueItem, country: CountryFile, policy: DomainPolicy, req: ResearchRequest, missing: readonly FollowupFact[], run: FestivalRun, opts: RefreshOptions, deps: RefreshDeps, guard: BudgetGuard): Promise<FestivalRun> {
  const fields = [...missing];
  const withLog = (followup: FollowupLog): FestivalRun => ({ ...run, log: { ...run.log, followup } });
  try {
    const wide = await researchPass(deps.transport, guard, req, 2);
    if (wide.outcome !== "ok") {
      deps.log.info(`${req.key}: follow-up search ${wide.outcome} for ${fields.join(", ")}`);
      return withLog({ fields, outcome: wide.outcome, citations: wide.citations.length });
    }
    const second = await extractAndReview(item, country, policy, wide.citations, opts, deps, guard);
    if (!second.ok) {
      deps.log.warn(`${req.key}: follow-up ${second.warning}`);
      return withLog({ fields, outcome: second.outcome, citations: wide.citations.length, detail: second.detail });
    }
    const wanted = new Set<string>(missing);
    const extra = second.changes.filter((c) => wanted.has(c.field));
    const answered = [...new Set(extra.filter((c) => c.verdict !== "rejected").map((c) => c.field))];
    return {
      log: { ...run.log, followup: { fields, outcome: "ok", citations: wide.citations.length, answered } },
      changes: [...run.changes, ...extra],
      notFound: run.notFound.filter((f) => !answered.includes(f)),
    };
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      deps.log.warn(`${req.key}: follow-up skipped: ${error.message}`);
      return withLog({ fields, outcome: "skipped_budget", detail: "R10: budget reached" });
    }
    const failure = classifyOrUnexpected(error);
    // Rejected credentials and bugs surface like any other festival failure (BE-04).
    if (failure.kind === "fatal" || failure.kind === "unexpected") throw error;
    deps.log.warn(`${req.key}: follow-up ${failure.kind}: ${failure.message}`);
    return withLog({ fields, outcome: failure.kind === "fixture" ? "no_fixture" : "api_error", detail: failure.message });
  }
}

function readChangelog(path: string): ChangelogEntry[] {
  return ChangelogEntry.array().parse(readJsonOr(path, []));
}

/** R13 over every country file; the same objects come back when nothing is lost. */
function lostSources(countries: readonly CountryFile[], links: ReadonlyMap<string, LinkVerdict> | undefined, changelog: readonly ChangelogEntry[], today: string): { countries: CountryFile[]; downgrades: LinkDowngrade[]; entries: ChangelogEntry[] } {
  if (!links) return { countries: [...countries], downgrades: [], entries: [] };
  const results = countries.map((c) => applyLostSources(c, links, changelog, today));
  return { countries: results.map((r) => r.country), downgrades: results.flatMap((r) => r.downgrades), entries: results.flatMap((r) => r.entries) };
}

export async function runRefresh(opts: RefreshOptions, deps: RefreshDeps): Promise<RefreshResult> {
  const config = readJson(join(opts.root, "config", "scoring.json")) as ScoringConfig;
  const stored = loadCountries(join(opts.root, "data", "countries"));
  if (opts.only && !stored.some((c) => c.festivals.some((f) => f.slug === opts.only))) {
    deps.log.error(`--only=${opts.only}: no festival with that slug`);
    return { exitCode: 1, report: null, files: [], calls: 0 };
  }
  const r13 = lostSources(stored, opts.links, readChangelog(join(opts.root, "data", "changelog.json")), opts.today);
  const countries = r13.countries;
  for (const d of r13.downgrades) deps.log.warn(`R13: ${d.country}/${d.slug} ${d.year}: every source is gone (404/410, no archive copy); confidence ${d.old} -> ${d.new}`);
  const sweep = opts.sweepWithin;
  const queue = buildQueue(countries, config, opts.today, { max: opts.maxFestivals, perCountry: opts.perCountry, only: opts.only, country: opts.country, ...(sweep !== undefined ? { sweepWithin: sweep } : {}) });
  const month = opts.today.slice(0, 7);
  const guard = createBudgetGuard({ month, budgetUsd: opts.budgetUsd, model: opts.model, store: deps.usage, log: deps.log, weekly: sweep === undefined });
  const policies = new Map(countries.map((c) => [c.country, loadDomainPolicy(opts.root, c.country)]));
  const mode = sweep !== undefined ? ` (news sweep, ${sweep} days)` : "";
  deps.log.info(`refresh ${opts.today}: ${queue.length} festival(s) queued${mode}${opts.dryRun ? " (dry run)" : ""}`);

  const logs: FestivalLog[] = [];
  const changes: ReviewedChange[] = [];
  const notFound: RefreshReport["not_found"] = [];
  let stopped: string | null = null;
  let fatal = false;
  // News sweeps look for cancellations only; dates are the weekly run's job.
  let followupsLeft = sweep === undefined ? (opts.maxFollowups ?? 0) : 0;
  const followups: FollowupBudget = {
    take() {
      const level = guard.level();
      if (followupsLeft <= 0 || (level !== "ok" && level !== "warn50")) return false;
      followupsLeft -= 1;
      return true;
    },
  };
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
      const run = await verifyFestival(item, country, policies.get(item.country)!, opts, deps, guard, followups);
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
      const failure = classifyOrUnexpected(error);
      if (failure.kind === "unexpected") {
        // A bug or bad data in one festival (code-F2): log it and keep verifying the others. In
        // Actions ($GITHUB_OUTPUT set) the line is a workflow annotation, so the run shows it (BE-04).
        logs.push({ ...baseLog(item), outcome: "error", detail: failure.message });
        const line = `${item.country}/${item.slug}: unexpected error: ${failure.message}`;
        if (opts.githubOutput) deps.log.info(`::error::${annotationText(line)}`);
        else deps.log.error(line);
        continue;
      }
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
  const trap = opts.trapSecret && sweep === undefined && guard.firstRunOfMonth && opts.githubOutput && !stopped && realChanges > 0
    ? makeTrap({ secret: opts.trapSecret, month, today: opts.today, countries, config, policies })
    : null;
  if (opts.trapSecret && guard.firstRunOfMonth && !trap) deps.log.info("R12: no trap this run (needs $GITHUB_OUTPUT, a real change and a dated upcoming edition)");

  const selection = demoteUnappliable(selectForPr(changes, trap), countries, opts.today, deps.log, policies);
  const drafts = draftProgress(countries, policies, queue, [...selection.applied, ...selection.confirmations], opts.today);
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
      ...(sweep !== undefined ? { sweep_within: sweep } : {}),
      ...(r13.downgrades.length ? { link_downgrades: r13.downgrades } : {}),
      ...(drafts.length ? { drafts } : {}),
    },
    selection,
  );
  // BE-04: unexpected errors alone do not fail a run that verified other festivals (their PR still
  // opens; refresh.yml fails the job afterwards), but a run that verified nothing goes red.
  const unexpected = logs.filter((l) => l.outcome === "error").length;
  const verified = logs.filter((l) => VERIFIED[l.outcome]).length;
  const blind = searchedBlind(logs, sweep);
  if (blind) {
    const line = `refresh ${opts.today}: all ${verified} festivals came back without a single citation; check the search setup (tool version, allowed_callers, domain lists) before the festivals`;
    if (opts.githubOutput) deps.log.info(`::error::${annotationText(line)}`);
    else deps.log.error(line);
  }
  const exitCode = stopped || fatal || blind || (unexpected > 0 && verified === 0) ? 1 : 0;
  const count = dataChangeCount(selection) + r13.downgrades.length;
  const output = { changes: stopped ? 0 : count, branch: `refresh/${opts.today}`, flagged: selection.flagged.length, unexpected, verified };
  if (count === 0 && selection.flagged.length === 0 && unexpected === 0) {
    // The report still goes to proposals/ (the run artifact), so an empty run can be diagnosed.
    deps.log.info(`refresh ${opts.today}: no changes (${selection.rejected.length} rejected); report only`);
    const files = writeProposals(opts.root, `${opts.today}`, report);
    appendGithubOutput(opts.githubOutput, output);
    return { exitCode, report, files, calls: guard.calls };
  }

  const files = writeProposals(opts.root, `${opts.today}`, report);
  if (!opts.dryRun && !stopped) {
    files.push(...(await applyRun(opts, deps, stored, countries, [...selection.applied, ...selection.confirmations], r13.entries)));
  }
  appendGithubOutput(opts.githubOutput, { ...output, ...(trap ? { trap_fingerprint: fingerprint(opts.trapSecret!, trap) } : {}) });
  deps.log.info(`refresh ${opts.today}: ${selection.applied.length} change(s), ${selection.confirmations.length} confirmation(s), ${selection.flagged.length} to review, ${selection.rejected.length} rejected, ${r13.downgrades.length} R13 downgrade(s)`);
  return { exitCode, report, files, calls: guard.calls };
}

/**
 * Whether the model answered: the pipeline worked for that festival, whatever it found. It decides
 * `verified`, the blind-search check and the exit code, so every outcome must say (a new one is a
 * compile error here until it does).
 */
const VERIFIED: Readonly<Record<FestivalOutcome, boolean>> = {
  ok: true,
  no_citations: true,
  refusal: true,
  truncated: true,
  invalid_proposal: true,
  api_error: false,
  error: false,
  no_fixture: false,
  skipped_budget: false,
  not_run: false,
};

/**
 * A weekly run where every researched festival (two or more) got no citation at all: the search
 * setup is broken, as on 2026-11-08 when dynamic filtering dropped every citation and the run still
 * went green. A sweep can legitimately find nothing, so it is never judged this way.
 */
export function searchedBlind(logs: readonly FestivalLog[], sweep: number | undefined): boolean {
  const researched = logs.filter((l) => VERIFIED[l.outcome]);
  return sweep === undefined && researched.length >= 2 && researched.every((l) => l.outcome === "no_citations");
}

/** R2 progress of the draft countries this run researched, with the selected changes applied. */
export function draftProgress(countries: readonly CountryFile[], policies: ReadonlyMap<string, DomainPolicy>, queue: readonly QueueItem[], accepted: readonly ReviewedChange[], today: string): DraftProgress[] {
  const researched = new Set(queue.map((i) => i.country));
  return countries
    .filter((c) => c.status === "borrador" && researched.has(c.country))
    .map((c) => {
      const policy = policies.get(c.country)!;
      const before = sourcedFestivals(c, policy);
      let after = before;
      try {
        after = sourcedFestivals(applyChanges(c, accepted, today), policy);
      } catch {
        // demoteUnappliable already left out changes that break the file; nothing more to count.
      }
      return { country: c.country, before, after, needed: MIN_SOURCED_FESTIVALS };
    });
}

/** One-line workflow-command data: `%`, CR and LF escaped as Actions expects. */
function annotationText(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function classifyOrUnexpected(error: unknown): ReturnType<typeof classifyApiError> | { kind: "unexpected"; message: string } {
  try {
    return classifyApiError(error);
  } catch {
    return { kind: "unexpected", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Changes that would make a country file invalid, or that build-data would then reject (BE-01),
 * move to «para revisar» with the message, before the report and the files are written, so the
 * run still opens its PR (code-F2).
 */
export function demoteUnappliable(selection: Selection, countries: readonly CountryFile[], today: string, log: Logger, policies?: ReadonlyMap<string, DomainPolicy>): Selection {
  const { failed } = trialApply(countries, [...selection.applied, ...selection.confirmations], today, policies);
  if (!failed.length) return selection;
  const bad = new Set(failed.map((f) => f.change));
  for (const f of failed) log.warn(`${f.change.country}/${f.change.slug} ${f.change.field}: not applied, sent to review: ${f.error}`);
  const flaggedNow = failed.map(({ change, error }) => ({ ...change, verdict: "flagged" as const, flags: [...change.flags, `revisar: no se puede aplicar (${error})`] }));
  return {
    ...selection,
    applied: selection.applied.filter((c) => !bad.has(c)),
    confirmations: selection.confirmations.filter((c) => !bad.has(c)),
    flagged: [...selection.flagged, ...flaggedNow],
  };
}

export function writeProposals(root: string, name: string, report: RefreshReport | Record<string, unknown>, markdown?: string): string[] {
  const json = join(root, "proposals", `${name}.json`);
  const md = join(root, "proposals", `${name}.md`);
  writeJson(json, report);
  writeText(md, markdown ?? renderRefreshMarkdown(report as RefreshReport));
  return [json, md];
}

/** `stored` is what is on disk; `countries` may already carry the R13 downgrades. */
async function applyRun(opts: RefreshOptions, deps: RefreshDeps, stored: readonly CountryFile[], countries: readonly CountryFile[], accepted: readonly ReviewedChange[], r13Entries: readonly ChangelogEntry[]): Promise<string[]> {
  const archived = await archiveAll(deps.archiver, accepted.flatMap((c) => c.sources.map((s) => s.url)));
  const files: string[] = [];
  countries.forEach((country, i) => {
    const next = applyChanges(country, accepted, opts.today, archived);
    if (next === stored[i]) return;
    const valid = CountryFile.parse(next);
    const path = join(opts.root, "data", "countries", `${country.country.toLowerCase()}.json`);
    writeJson(path, valid);
    files.push(path);
  });
  const entries = [...r13Entries, ...changelogEntries(accepted, opts.today)];
  if (entries.length) {
    const path = join(opts.root, "data", "changelog.json");
    writeJson(path, [...readChangelog(path), ...entries]);
    files.push(path);
  }
  return files;
}
