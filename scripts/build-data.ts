// Validates data/countries/*.json against src/schema.ts and writes what the site serves:
// data/index.json (committed, published only) and public/data/** (build output).
// Drafts («borrador») are copied only with INCLUDE_DRAFTS=1, so they never reach production.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CountryFile, type CountryFile as Country } from "../src/schema.ts";
import { scoreFestival, type ScoringConfig } from "../src/score.ts";
import { isMainModule } from "./lib/is-main.ts";

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

export interface PublicIndex {
  generated_at: string;
  countries: IndexCountry[];
  tier1: string[];
  slugs: Record<string, string>;
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

export function buildIndex(countries: readonly Country[], config: ScoringConfig, includeDrafts: boolean): PublicIndex {
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
      const withA = dated.filter((e) => e.sources.some((s) => s.tier === "A"));
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
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const includeDrafts = process.env.INCLUDE_DRAFTS === "1";
  const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
  const countries = loadCountries("data/countries");

  writeFileSync("data/index.json", `${JSON.stringify(buildIndex(countries, config, false), null, 2)}\n`);

  rmSync("public/data", { recursive: true, force: true });
  mkdirSync("public/data/countries", { recursive: true });
  writeFileSync("public/data/index.json", JSON.stringify(buildIndex(countries, config, includeDrafts)));
  for (const c of countries) {
    if (c.status === "publicado" || includeDrafts) {
      writeFileSync(`public/data/countries/${c.country.toLowerCase()}.json`, JSON.stringify(c));
    }
  }
  if (existsSync("data/changelog.json")) copyFileSync("data/changelog.json", "public/data/changelog.json");
  const drafts = countries.filter((c) => c.status === "borrador").map((c) => c.country);
  console.log(`build-data: ${countries.length} countries validated; drafts ${includeDrafts ? "included" : "excluded"}: ${drafts.join(", ") || "none"}`);
}
