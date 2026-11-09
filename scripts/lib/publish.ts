// A draft goes live by itself once it passes everything build-data checks for a «publicado»
// country (R2: MIN_SOURCED_FESTIVALS dated festivals on an A or B source, plus the domain checks).
// There is no other way to «publicado»; build-data stays the guard.
import type { ISO } from "../../src/dates.ts";
import { MIN_SOURCED_FESTIVALS, type CountryFile } from "../../src/schema.ts";
import { dataProblems, sourcedFestivals } from "../build-data.ts";
import type { DomainPolicy } from "./domains.ts";

export interface Readiness {
  ok: boolean;
  sourced: number;
  needed: number;
  problems: string[];
}

export function readiness(country: CountryFile, policies: ReadonlyMap<string, DomainPolicy>, today: ISO): Readiness {
  const live = { ...country, status: "publicado" as const };
  const policy = policies.get(country.country);
  const problems = dataProblems([live], policies, today);
  const sourced = policy ? sourcedFestivals(live, policy) : 0;
  return { ok: problems.length === 0, sourced, needed: MIN_SOURCED_FESTIVALS, problems };
}

/** Drafts that are ready come back «publicado»; the others are returned as they were. */
export function promoteReady(countries: readonly CountryFile[], policies: ReadonlyMap<string, DomainPolicy>, today: ISO): { countries: CountryFile[]; promoted: string[] } {
  const promoted: string[] = [];
  const out = countries.map((c) => {
    if (c.status !== "borrador" || !readiness(c, policies, today).ok) return c;
    promoted.push(c.country);
    return { ...c, status: "publicado" as const };
  });
  return { countries: out, promoted };
}
