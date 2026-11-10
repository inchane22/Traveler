// Discovery (2026-11-10): a live country's calendar keeps growing. One research call asks for the
// parties its file does not have yet (the known ones are listed), one extraction maps them onto the
// onboarding contract, and code keeps a candidate only when it is new, a cited source says people
// party there, and a date or a date rule rests on a cited A or B source. At most `maxNew` are
// added a run, best score first, each with a changelog entry «festival» naming its sources.
// Anything doubtful (a name close to a listed festival, a check build-data would fail) is skipped,
// never applied. The planner (plan.ts) schedules it per country every `discover_every_days`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addMonths, type ISO } from "../../src/dates.ts";
import { ChangelogEntry, CountryFile, type Festival } from "../../src/schema.ts";
import { isParty, scoreFestival, type ScoringConfig } from "../../src/score.ts";
import { dataProblems } from "../build-data.ts";
import { archiveAll, noopArchiver, type Archiver } from "./archive.ts";
import { BudgetExceededError, createBudgetGuard, type UsageStore } from "./budget.ts";
import { classifyApiError, type MessagesTransport } from "./client.ts";
import { loadDomainPolicy, withGovernmentFallback, type DomainPolicy } from "./domains.ts";
import { extract, fence } from "./extract.ts";
import { loadPrompt, readJson, writeJson, writeText, type Logger } from "./io.ts";
import { countryInfo } from "./lang.ts";
import type { Job } from "./ledger.ts";
import { details, mdLink, mdTable, mdText } from "./markdown.ts";
import { mapFestival, OnboardingDraft, slugify, type MappedFestival } from "./onboard-draft.ts";
import { withArchives } from "./onboard-run.ts";
import { research } from "./research.ts";

/** Searches one discovery may run: fewer than an onboarding, it only looks for what is missing. */
export const DISCOVER_MAX_USES = 8;

export interface DiscoverOptions {
  root: string;
  country: string;
  today: ISO;
  model: string;
  budgetUsd: number;
  /** Most festivals added this run. */
  maxNew: number;
  /** `discover` in upkeep; `build` when a draft's retry build looks for more festivals. */
  job?: Job;
  dryRun?: boolean;
}

export interface DiscoverDeps {
  transport: MessagesTransport;
  usage: UsageStore;
  log: Logger;
  archiver?: Archiver;
}

export interface DiscoveredFestival {
  country: string;
  slug: string;
  name: string;
  city: string;
  dated: boolean;
  sources: string[];
}

export interface DiscoverReport {
  kind: "discover";
  date: ISO;
  country: string;
  model: string;
  dry_run: boolean;
  added: DiscoveredFestival[];
  skipped: string[];
  not_found: string[];
}

export interface DiscoverResult {
  exitCode: number;
  /** Set when the run stopped at the monthly budget (R10). */
  stopped?: string;
  report: DiscoverReport | null;
  files: string[];
}

const STOP_WORDS = new Set([
  "de", "del", "la", "las", "los", "el", "y", "en", "da", "do", "dos", "das", "e", "the", "of", "and", "a",
  "fiesta", "fiestas", "festa", "festas", "festival", "festivales", "feria", "feira", "fair", "nacional", "national",
  "internacional", "international", "gran", "grande", "great", "san", "santa", "santo", "sao", "saint",
]);

const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function nameTokens(name: string, city: string): Set<string> {
  const cityWords = new Set(fold(city).split(" "));
  return new Set(fold(name).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !cityWords.has(w) && !/^\d+$/.test(w)));
}

/**
 * Could `b` be `a` under another name? Same slug or same full name anywhere; in the same city, one
 * name inside the other («Salsódromo de la Feria de Cali») or half of the smaller set of
 * distinctive name words in common. Errs towards «yes»: a doubtful candidate is skipped, not added.
 */
export function sameFestival(a: Festival, b: Festival): boolean {
  if (a.slug === b.slug) return true;
  const namesA = [a.names.local, a.names.es, a.names.en, a.names.pt];
  const namesB = [b.names.local, b.names.es, b.names.en, b.names.pt];
  const fullA = new Set(namesA.map(fold));
  if (namesB.some((n) => fullA.has(fold(n)))) return true;
  if (fold(a.city) !== fold(b.city)) return false;
  for (const na of namesA) {
    const ta = nameTokens(na, a.city);
    for (const nb of namesB) {
      const [fa, fb] = [` ${fold(na)} `, ` ${fold(nb)} `];
      if (fa.includes(fb) || fb.includes(fa)) return true;
      const tb = nameTokens(nb, b.city);
      if (!ta.size || !tb.size) continue;
      const common = [...ta].filter((w) => tb.has(w)).length;
      if (common / Math.min(ta.size, tb.size) >= 0.5) return true;
    }
  }
  return false;
}

export interface Selection {
  added: Festival[];
  /** Mapped candidate → why it was not added. */
  skipped: string[];
}

/**
 * Which mapped candidates join the country file. Pure: the country, every slug the site already
 * uses (all countries), the mapped candidates, scoring, the domain policy and today.
 */
export function selectNew(country: CountryFile, usedSlugs: ReadonlySet<string>, mapped: readonly MappedFestival[], config: ScoringConfig, policy: DomainPolicy, today: ISO, maxNew: number): Selection {
  const skipped: string[] = [];
  const policies = new Map([[country.country, policy]]);
  const baseline = new Set(dataProblems([country], policies, today));
  const keep: Array<{ festival: Festival; low: number; high: number }> = [];
  const taken = new Set(usedSlugs);
  for (const m of mapped) {
    const f = m.festival;
    const name = `${f.names.es} (${f.city})`;
    const twin = [...country.festivals, ...keep.map((k) => k.festival)].find((known) => sameFestival(known, f));
    if (twin) {
      skipped.push(`${name}: already on the calendar as ${twin.slug}`);
      continue;
    }
    if (!isParty(f.score)) {
      skipped.push(`${name}: a cited source describes a solemn act`);
      continue;
    }
    if (!f.score.fiesta) {
      skipped.push(`${name}: no cited source says what visitors do there`);
      continue;
    }
    if (!m.datedEdition && !m.verified.includes("rule")) {
      skipped.push(`${name}: no cited date or date rule`);
      continue;
    }
    if (!m.sources.some((s) => s.tier === "A" || s.tier === "B")) {
      skipped.push(`${name}: only tier-C sources`);
      continue;
    }
    const score = scoreFestival(f.score, config);
    if (score.tier === "hidden") {
      skipped.push(`${name}: scores below the calendar's bar (${score.low}-${score.high})`);
      continue;
    }
    let slug = f.slug;
    if (taken.has(slug)) slug = slugify(`${f.slug}-${f.city}`);
    if (!slug || taken.has(slug)) {
      skipped.push(`${name}: slug ${f.slug} is taken`);
      continue;
    }
    const festival = { ...f, slug };
    const trial = dataProblems([{ ...country, festivals: [...country.festivals, festival] }], policies, today).filter((p) => !baseline.has(p));
    if (trial.length) {
      skipped.push(`${name}: ${trial[0]}`);
      continue;
    }
    taken.add(slug);
    keep.push({ festival, low: score.low, high: score.high });
  }
  keep.sort((a, b) => b.low - a.low || b.high - a.high || a.festival.slug.localeCompare(b.festival.slug));
  for (const k of keep.slice(maxNew)) skipped.push(`${k.festival.names.es} (${k.festival.city}): over this run's limit of ${maxNew}; next discovery`);
  return { added: keep.slice(0, maxNew).map((k) => k.festival), skipped };
}

function festivalSources(f: Festival): string[] {
  const urls = [
    ...Object.values(f.editions).flatMap((e) => e.sources.map((s) => s.url)),
    ...Object.values(f.score).flatMap((m) => (m?.source ? [m.source] : [])),
  ];
  return [...new Set(urls)];
}

/** A new festival in the changelog: «festival», nothing before, its Spanish name after. */
export function discoveryEntries(country: string, added: readonly Festival[], today: ISO): ChangelogEntry[] {
  return added.map((f) => ChangelogEntry.parse({ date: today, country, slug: f.slug, field: "festival", old: null, new: f.names.es, source_urls: festivalSources(f).slice(0, 5) }));
}

export function renderDiscoverMarkdown(r: DiscoverReport): string {
  const rows = r.added.map((f) => [mdText(f.name, 60), mdText(f.city, 40), f.dated ? "sí" : "regla", f.sources.map((u, i) => mdLink(`[${i + 1}]`, u)).join(" ")]);
  const parts = [
    `## Nuevas fiestas ${r.country} (${r.date})`,
    `Búsqueda de fiestas que el calendario aún no tiene. Solo entran las nuevas que una fuente citada describe como fiesta y con fecha o regla de fecha en una fuente A o B. Modelo: \`${mdText(r.model, 40)}\`${r.dry_run ? " · ensayo (--dry-run)" : ""}.`,
    r.added.length ? mdTable(["Fiesta", "Ciudad", "Fecha", "Fuentes"], rows) : "Ninguna nueva esta vez.",
  ];
  if (r.skipped.length) parts.push(details(`Descartadas (${r.skipped.length})`, r.skipped.map((d) => `- ${mdText(d, 200)}`).join("\n")));
  if (r.not_found.length) parts.push(details("No encontrado", r.not_found.map((d) => `- ${mdText(d, 120)}`).join("\n")));
  return `${parts.join("\n\n")}\n`;
}

/** Every slug the site uses: a slug is unique across countries (build-data's index). */
function usedSlugs(root: string): Set<string> {
  const dir = join(root, "data", "countries");
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => /^[a-z]{2}\.json$/.test(f))) {
    const c = CountryFile.safeParse(readJson(join(dir, file)));
    if (c.success) for (const f of c.data.festivals) out.add(f.slug);
  }
  return out;
}

function readChangelog(path: string): ChangelogEntry[] {
  return existsSync(path) ? ChangelogEntry.array().parse(JSON.parse(readFileSync(path, "utf8"))) : [];
}

export async function runDiscover(opts: DiscoverOptions, deps: DiscoverDeps): Promise<DiscoverResult> {
  const cc = opts.country.toUpperCase();
  const fail = (message: string, stopped?: string): DiscoverResult => {
    deps.log.error(message);
    return { exitCode: 1, ...(stopped ? { stopped } : {}), report: null, files: [] };
  };
  const info = countryInfo(cc);
  if (!info) return fail(`discover ${cc}: no country facts in scripts/lib/lang.ts`);
  const path = join(opts.root, "data", "countries", `${cc.toLowerCase()}.json`);
  if (!existsSync(path)) return fail(`discover ${cc}: no country file; onboarding builds it first`);
  const country = CountryFile.parse(readJson(path));
  const config = readJson(join(opts.root, "config", "scoring.json")) as ScoringConfig;
  const policy = withGovernmentFallback(loadDomainPolicy(opts.root, cc));
  const job = opts.job ?? "discover";
  const guard = createBudgetGuard({ month: opts.today.slice(0, 7), today: opts.today, budgetUsd: opts.budgetUsd, model: opts.model, store: deps.usage, log: deps.log, job });
  // R10: like the follow-up searches, discovery waits for next month once 80% is spent.
  if (guard.level() === "degraded80" || guard.level() === "stopped") {
    deps.log.warn(`discover ${cc}: skipped, the month's budget is at ${guard.level()}`);
    return { exitCode: 0, report: null, files: [] };
  }
  const key = `discover/${cc}`;
  const known = country.festivals.map((f) => `- ${fence(f.names.es)} (${fence(f.city)})`).join("\n") || "- (none)";

  let draft: OnboardingDraft;
  let citations;
  try {
    const result = await research(deps.transport, guard, {
      key,
      model: opts.model,
      system: loadPrompt("discover-research-system.md"),
      user: loadPrompt("discover-research-user.md", {
        country_name: info.names.en,
        country: cc,
        lang: info.local,
        today: opts.today,
        horizon: addMonths(opts.today, 12),
        known,
        max: String(opts.maxNew + 2),
      }),
      country: cc,
      timezone: info.timezone,
      maxUses: DISCOVER_MAX_USES,
      allowedDomains: [],
      blockedDomains: policy.blocked,
    });
    if (result.outcome === "no_citations") {
      deps.log.info(`discover ${cc}: the research cited nothing; nothing new this time`);
      return { exitCode: 0, report: null, files: [] };
    }
    if (result.outcome !== "ok") return fail(`discover ${cc}: research ${result.outcome}${result.refusalCategory ? ` (${result.refusalCategory})` : ""}`);
    citations = result.citations;
    const extracted = await extract(deps.transport, guard, {
      key,
      model: opts.model,
      system: loadPrompt("onboard-extract-system.md"),
      context: `País: ${info.names.es} (${cc}). Zona por defecto: ${info.timezone}. Hoy: ${opts.today}.\nYa están en el calendario; no las repitas:\n${known}`,
      citations: result.citations,
      schema: OnboardingDraft,
      maxTokens: 16000,
    });
    if (!extracted.ok) return fail(`discover ${cc}: extraction dropped after ${extracted.attempts} attempt(s): ${extracted.reason} ${extracted.detail}`);
    draft = extracted.value;
  } catch (error) {
    if (error instanceof BudgetExceededError) return fail(error.message, error.message);
    const failure = classifyApiError(error);
    return fail(`discover ${cc}: ${failure.kind}: ${failure.message}`);
  }
  if (draft.country.toUpperCase() !== cc) return fail(`discover ${cc}: the draft is for ${draft.country}`);

  const ctx = { citations, policy };
  const skipped: string[] = [];
  const mapped: MappedFestival[] = [];
  for (const f of draft.festivals.slice(0, 10)) {
    const m = mapFestival(f, cc, info.timezone, ctx, opts.today);
    if ("error" in m) skipped.push(m.error);
    else mapped.push(m);
  }
  const selection = selectNew(country, usedSlugs(opts.root), mapped, config, policy, opts.today, opts.maxNew);
  skipped.push(...selection.skipped);
  const added = selection.added;
  const report: DiscoverReport = {
    kind: "discover",
    date: opts.today,
    country: cc,
    model: opts.model,
    dry_run: !!opts.dryRun,
    added: added.map((f) => ({ country: cc, slug: f.slug, name: f.names.es, city: f.city, dated: Object.values(f.editions).some((e) => !!e.start), sources: festivalSources(f) })),
    skipped,
    not_found: draft.not_found,
  };
  const name = `discover-${cc.toLowerCase()}-${opts.today}`;
  const files = [join(opts.root, "proposals", `${name}.json`), join(opts.root, "proposals", `${name}.md`)];
  writeJson(files[0]!, report);
  writeText(files[1]!, renderDiscoverMarkdown(report));
  if (added.length && !opts.dryRun) {
    const urls = added.flatMap((f) => Object.values(f.editions).flatMap((e) => e.sources.map((s) => s.url)));
    const archived = await archiveAll(deps.archiver ?? noopArchiver, urls);
    const next = withArchives({ ...country, generated_at: opts.today, festivals: [...country.festivals, ...added] }, archived);
    writeJson(path, CountryFile.parse(next));
    const changelogPath = join(opts.root, "data", "changelog.json");
    writeJson(changelogPath, [...readChangelog(changelogPath), ...discoveryEntries(cc, added, opts.today)]);
    files.push(path, changelogPath);
  }
  for (const f of report.added) deps.log.info(`discover ${cc}: new festival ${f.slug} (${f.name}, ${f.city})`);
  deps.log.info(`discover ${cc}: ${added.length} new, ${skipped.length} skipped`);
  return { exitCode: 0, report, files };
}
