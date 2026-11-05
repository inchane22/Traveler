// Source domains: official list (oficial confidence), A/B/C tiers and blocked domains (R2, R7).
// A configured domain matches itself and its subdomains (docs/architecture.md «Config files»).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type SourceTier = "A" | "B" | "C";

const Domain = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "plain lowercase hostname")
  .transform((d) => d.replace(/^www\./, ""));

export const OfficialDomainsFile = z.object({ country: z.string().regex(/^[A-Z]{2}$/), domains: z.array(Domain) }).strict();
export const SourcesFile = z
  .object({ country: z.string().regex(/^[A-Z]{2}$/), A: z.array(Domain), B: z.array(Domain), blocked: z.array(Domain) })
  .strict();

export interface DomainPolicy {
  country: string;
  official: readonly string[];
  A: readonly string[];
  B: readonly string[];
  blocked: readonly string[];
}

/**
 * Second-level public suffixes seen in the pilot regions. Without them every `*.com.co` outlet
 * collapses into `com.co` and «two independent sources» (R1/R2) would never hold.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "com.co", "gov.co", "org.co", "edu.co", "net.co", "mil.co",
  "com.pe", "gob.pe", "org.pe", "edu.pe", "net.pe",
  "com.bo", "gob.bo", "org.bo", "edu.bo",
  "com.br", "gov.br", "org.br", "edu.br", "net.br", "art.br",
  "com.mx", "gob.mx", "org.mx", "edu.mx",
  "com.ar", "gob.ar", "gov.ar", "org.ar",
  "com.ec", "gob.ec", "org.ec",
  "co.uk", "gov.uk", "org.uk", "ac.uk",
  "com.au", "gov.au", "org.au",
  "co.in", "gov.in", "nic.in",
  "co.th", "go.th", "or.th",
  "com.tt", "gov.tt",
]);

/** Lowercase hostname without a leading `www.`; null for anything that is not an https URL. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function matchesAny(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => matchesDomain(host, d));
}

/** eTLD+1, with the small suffix list above (no network, no PSL dependency). */
export function registrableDomain(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Canonical form used to compare a proposal URL with the search citations. */
export function canonicalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `https://${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function isBlocked(url: string, policy: DomainPolicy): boolean {
  const host = hostOf(url);
  return host !== null && matchesAny(host, policy.blocked);
}

export function isOfficial(url: string, policy: DomainPolicy): boolean {
  const host = hostOf(url);
  return host !== null && matchesAny(host, policy.official);
}

/** A = organizer or government (official list counts as A), B = recognized national press, C = rest. */
export function tierOf(url: string, policy: DomainPolicy): SourceTier {
  const host = hostOf(url);
  if (!host) return "C";
  if (matchesAny(host, policy.A) || matchesAny(host, policy.official)) return "A";
  if (matchesAny(host, policy.B)) return "B";
  return "C";
}

/** Domains for the first, restricted search pass (R7): official + tier A, at most 64 entries. */
export function firstPassDomains(policy: DomainPolicy): string[] {
  return [...new Set([...policy.official, ...policy.A])].slice(0, 64);
}

export function emptyPolicy(country: string): DomainPolicy {
  return { country, official: [], A: [], B: [], blocked: [] };
}

/**
 * Fallback for a country with no config yet (onboarding): its government suffixes and UNESCO count
 * as A and official; there is no press list, so press stays C until a person writes config/sources.
 */
export function defaultGovernmentDomains(country: string): string[] {
  const cc = country.toLowerCase();
  return [`gov.${cc}`, `gob.${cc}`, `gub.${cc}`, `gouv.${cc}`, `go.${cc}`, "unesco.org"];
}

/** A person has written config for the country: some official, A or B domain is listed. */
export function hasConfig(policy: DomainPolicy): boolean {
  return policy.official.length > 0 || policy.A.length > 0 || policy.B.length > 0;
}

export function withGovernmentFallback(policy: DomainPolicy): DomainPolicy {
  if (hasConfig(policy)) return policy;
  const gov = defaultGovernmentDomains(policy.country);
  return { ...policy, official: gov, A: gov };
}

/** Loads config/official-domains/<cc>.json and config/sources/<cc>.json; missing files mean empty lists. */
export function loadDomainPolicy(root: string, country: string): DomainPolicy {
  const cc = country.toLowerCase();
  const officialPath = join(root, "config", "official-domains", `${cc}.json`);
  const sourcesPath = join(root, "config", "sources", `${cc}.json`);
  const official = existsSync(officialPath) ? OfficialDomainsFile.parse(JSON.parse(readFileSync(officialPath, "utf8"))) : null;
  const sources = existsSync(sourcesPath) ? SourcesFile.parse(JSON.parse(readFileSync(sourcesPath, "utf8"))) : null;
  for (const file of [official, sources]) {
    if (file && file.country !== country.toUpperCase()) throw new Error(`config for ${cc} declares country ${file.country}`);
  }
  return {
    country: country.toUpperCase(),
    official: official?.domains ?? [],
    A: sources?.A ?? [],
    B: sources?.B ?? [],
    blocked: sources?.blocked ?? [],
  };
}
