// Validates data/countries/*.json against src/schema.ts and writes what the site serves:
// data/index.json (committed, published only) and public/data/** (build output).
// Drafts («borrador») are copied only with INCLUDE_DRAFTS=1, so they never reach production.
// DATA_DIR (default `data`) builds from another data tree: the e2e suite builds the site from the
// frozen copy in tests/fixtures/site, so the pipeline's daily commits cannot break UI tests.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMonths, todayIn, type ISO } from "../src/dates.ts";
import { ChangelogEntry, CountryFile, MIN_SOURCED_FESTIVALS, type CountryFile as Country, type Edition } from "../src/schema.ts";
import { CRITERIA, scoreFestival, type ScoringConfig } from "../src/score.ts";
import { quoteStatesDate } from "./lib/date-parser.ts";
import { hasConfig, isOfficial, loadDomainPolicy, tierOf, type DomainPolicy } from "./lib/domains.ts";
import { isMainModule } from "./lib/is-main.ts";
import { localLangFor } from "./lib/lang.ts";
import { RequestsFile, type CountryRequest } from "./lib/requests.ts";
import { loadSensitiveTerms, sensitiveHits } from "./lib/sensitive.ts";

export interface IndexCountry {
  code: string;
  status: Country["status"];
  region: Country["region"];
  timezone: string;
  festivals: number;
  last_verified: string | null;
  /** Share of dated editions backed by a tier-A source (R2 coverage). */
  share_a: number;
}

/** A country someone asked for that is not live yet (data/state/requests.json). */
export interface IndexRequest {
  code: string;
  status: "queued" | "retry" | "gave_up";
  /** Next try, for «retry». */
  retry_after?: string;
}

export interface PublicIndex {
  generated_at: string;
  countries: IndexCountry[];
  tier1: string[];
  slugs: Record<string, string>;
  /** Requested countries that are not live yet, so their page can say where the build is. */
  requests: IndexRequest[];
}

/** Requests the site shows: not live and not already among the countries it serves. */
export function indexRequests(requests: readonly CountryRequest[], shown: ReadonlySet<string>): IndexRequest[] {
  return requests
    .filter((r): r is CountryRequest & { status: IndexRequest["status"] } => r.status !== "live" && !shown.has(r.country))
    .map((r) => ({ code: r.country, status: r.status, ...(r.status === "retry" && r.retry_after ? { retry_after: r.retry_after } : {}) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function loadCountries(dir: string): Country[] {
  return readdirSync(dir)
    .filter((f) => /^[a-z]{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      const parsed = CountryFile.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      if (`${parsed.data.country.toLowerCase()}.json` !== f) throw new Error(`${f}: country code does not match file name`);
      return parsed.data;
    });
}

/**
 * R2 coverage: an edition counts as A-backed only when a source that config/sources ranks A (or,
 * without a policy, that declares A) carries a quote stating the stored start or end day.
 */
export function isABacked(edition: Edition, country: string, policy?: DomainPolicy): boolean {
  const lang = localLangFor(country);
  return edition.sources.some((s) => {
    const tier = policy ? tierOf(s.url, policy) : s.tier;
    if (tier !== "A" || !s.quote) return false;
    return (!!edition.start && quoteStatesDate(s.quote, lang, edition.start, "start")) || (!!edition.end && quoteStatesDate(s.quote, lang, edition.end, "end"));
  });
}

/** Festivals with an edition that has start, end and a source config/sources ranks A or B. */
export function sourcedFestivals(country: Country, policy: DomainPolicy): number {
  return country.festivals.filter((f) =>
    Object.values(f.editions).some((e) => !!e.start && !!e.end && e.sources.some((s) => tierOf(s.url, policy) !== "C")),
  ).length;
}

/** How far ahead a lunisolar table must reach (PRD R4: alert without the row for the next 12 months). */
export const LUNAR_HORIZON_MONTHS = 12;

/**
 * Checks the schema cannot make because they need config/: the declared tier matches
 * config/sources (R2), «oficial» figures sit on config/official-domains, «prensa» figures on an A
 * or B source, and every lunisolar table covers the next 12 months (R4). Empty means clean.
 * A «borrador» with no config yet skips the three domain checks: onboarding ranked its sources
 * with the government fallback, and the reviewer writes config/ before publishing (BE-02).
 */
export function dataProblems(countries: readonly Country[], policies: ReadonlyMap<string, DomainPolicy>, today: ISO): string[] {
  const problems: string[] = [];
  const horizon = addMonths(today, LUNAR_HORIZON_MONTHS);
  for (const c of countries) {
    const policy = policies.get(c.country);
    if (!policy) {
      problems.push(`${c.country}: no domain policy loaded`);
      continue;
    }
    // R2 / PRD «Onboarding de un país»: published only with 3 festivals with date and an A or B source.
    const sourced = sourcedFestivals(c, policy);
    if (c.status === "publicado" && sourced < MIN_SOURCED_FESTIVALS) {
      problems.push(`${c.country}: «publicado» needs ${MIN_SOURCED_FESTIVALS} festivals with a dated edition on an A or B source; has ${sourced}. Keep it «borrador».`);
    }
    const checkDomains = c.status === "publicado" || hasConfig(policy);
    for (const f of c.festivals) {
      const where = `${c.country}/${f.slug}`;
      for (const [year, e] of checkDomains ? Object.entries(f.editions) : []) {
        for (const s of e.sources) {
          const tier = tierOf(s.url, policy);
          if (s.tier && s.tier !== tier) problems.push(`${where} ${year}: ${s.url} declares tier ${s.tier}, config/sources gives ${tier}`);
        }
      }
      for (const key of checkDomains ? CRITERIA : []) {
        const m = f.score[key];
        if (!m?.source) continue;
        if (m.confidence === "oficial" && !isOfficial(m.source, policy)) problems.push(`${where} score.${key}: «oficial» needs a source on config/official-domains, got ${m.source}`);
        if (m.confidence === "prensa" && tierOf(m.source, policy) === "C") problems.push(`${where} score.${key}: «prensa» needs an A or B source, got tier C ${m.source}`);
      }
      if (f.rule.type === "lunisolar_table") {
        const rows = Object.values(f.rule.table);
        const covered = rows.some((r) => r.end >= today) && rows.some((r) => r.start >= horizon || r.end >= horizon);
        if (!covered) problems.push(`${where}: lunisolar table has no row reaching ${horizon} (R4); add the next years from ${f.rule.table_source}`);
      }
    }
  }
  return problems;
}

/** Changelog entries the site may show: only countries it serves (a draft's changes stay private). */
export function publicChangelog(entries: readonly ChangelogEntry[], shown: ReadonlySet<string>): ChangelogEntry[] {
  return entries.filter((e) => shown.has(e.country));
}

export function buildIndex(countries: readonly Country[], config: ScoringConfig, includeDrafts: boolean, policies?: ReadonlyMap<string, DomainPolicy>, requests: readonly CountryRequest[] = []): PublicIndex {
  const shown = countries.filter((c) => c.status === "publicado" || includeDrafts);
  const slugs: Record<string, string> = {};
  for (const c of shown) {
    for (const f of c.festivals) {
      if (slugs[f.slug]) throw new Error(`slug ${f.slug} used by ${slugs[f.slug]} and ${c.country}`);
      slugs[f.slug] = c.country;
    }
  }
  return {
    generated_at: shown.map((c) => c.generated_at).sort().at(-1) ?? "1970-01-01",
    countries: shown.map((c) => {
      const editions = c.festivals.flatMap((f) => Object.values(f.editions));
      const verified = editions.map((e) => e.last_verified).filter((d): d is string => !!d).sort();
      const dated = editions.filter((e) => e.start);
      const withA = dated.filter((e) => isABacked(e, c.country, policies?.get(c.country)));
      return {
        code: c.country,
        status: c.status,
        region: c.region,
        timezone: c.timezone,
        festivals: c.festivals.length,
        last_verified: verified.at(-1) ?? null,
        share_a: dated.length ? Math.round((withA.length / dated.length) * 100) / 100 : 0,
      };
    }),
    tier1: shown
      .filter((c) => c.status === "publicado")
      .flatMap((c) => c.festivals.filter((f) => scoreFestival(f.score, config).tier === 1).map((f) => `${c.country}/${f.slug}`)),
    slugs,
    requests: indexRequests(requests, new Set(shown.map((c) => c.country))),
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const includeDrafts = process.env.INCLUDE_DRAFTS === "1";
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
  const countries = loadCountries(join(dataDir, "countries"));
  const policies = new Map(countries.map((c) => [c.country, loadDomainPolicy(".", c.country)]));
  const today = todayIn("UTC");
  const problems = dataProblems(countries, policies, today);
  if (problems.length) {
    console.error(`build-data: ${problems.length} data problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
  // R5: a sensitive term does not block the build; it asks a person to read that text.
  const terms = loadSensitiveTerms(".");
  for (const hit of countries.flatMap((c) => c.festivals.flatMap((f) => sensitiveHits(f, terms)))) {
    console.warn(`build-data: R5 review ${hit.slug} ${hit.field}: «${hit.term}»`);
  }

  const requestsPath = join(dataDir, "state", "requests.json");
  const requests = existsSync(requestsPath) ? RequestsFile.parse(JSON.parse(readFileSync(requestsPath, "utf8"))) : [];
  writeFileSync(join(dataDir, "index.json"), `${JSON.stringify(buildIndex(countries, config, false, policies, requests), null, 2)}\n`);

  rmSync("public/data", { recursive: true, force: true });
  mkdirSync("public/data/countries", { recursive: true });
  writeFileSync("public/data/index.json", JSON.stringify(buildIndex(countries, config, includeDrafts, policies, requests)));
  const shown = new Set<string>();
  for (const c of countries) {
    if (c.status === "publicado" || includeDrafts) {
      writeFileSync(`public/data/countries/${c.country.toLowerCase()}.json`, JSON.stringify(c));
      shown.add(c.country);
    }
  }
  const changelogPath = join(dataDir, "changelog.json");
  if (existsSync(changelogPath)) {
    const entries = ChangelogEntry.array().parse(JSON.parse(readFileSync(changelogPath, "utf8")));
    writeFileSync("public/data/changelog.json", JSON.stringify(publicChangelog(entries, shown)));
  }
  const drafts = countries.filter((c) => c.status === "borrador").map((c) => c.country);
  console.log(`build-data: ${countries.length} countries validated; drafts ${includeDrafts ? "included" : "excluded"}: ${drafts.join(", ") || "none"}`);
}
