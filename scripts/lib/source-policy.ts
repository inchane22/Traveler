// Source policy for a country nobody has configured yet (R2, R7): which domains count as official
// or A, which press is B, which sites are blocked. One small call without web search drafts it;
// code keeps only well-formed hostnames, always adds the government suffixes and UNESCO, and falls
// back to those alone when the call fails. Written to config/official-domains/<cc>.json and
// config/sources/<cc>.json, where the rest of the pipeline reads it like hand-written config.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BudgetExceededError } from "./budget.ts";
import { classifyApiError, type MessagesTransport } from "./client.ts";
import { defaultGovernmentDomains, OfficialDomainsFile, SourcesFile } from "./domains.ts";
import { extract } from "./extract.ts";
import { loadPrompt, writeJson, type Logger } from "./io.ts";
import type { CallGate } from "./research.ts";

export const SourcePolicyDraft = z
  .object({
    country: z.string(),
    official: z.array(z.string()),
    press: z.array(z.string()),
    blocked: z.array(z.string()),
  })
  .strict();
export type SourcePolicyDraft = z.infer<typeof SourcePolicyDraft>;

/** Resellers and aggregators every country blocks (they publish dates without being a source). */
export const ALWAYS_BLOCKED = ["viagogo.com", "stubhub.com", "allevents.in", "happeningnext.com"];

/** Never press, whatever the draft says: encyclopedias, social networks, platforms, travel guides. */
const NOT_PRESS = [
  "wikipedia.org", "wikimedia.org", "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com", "tiktok.com",
  "tripadvisor.com", "lonelyplanet.com", "google.com", "blogspot.com", "wordpress.com", "medium.com", "eventbrite.com",
  "timeout.com", "culturetrip.com", "reddit.com", "linkedin.com", "pinterest.com",
];

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A bare lowercase hostname, `www.` dropped; anything else (scheme, path, spaces) is discarded. */
export function cleanHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return HOST.test(host) && host.length <= 100 ? host : null;
}

const under = (host: string, domains: readonly string[]): boolean => domains.some((d) => host === d || host.endsWith(`.${d}`));

function uniqueHosts(list: readonly string[], max: number, keep: (h: string) => boolean): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const h = cleanHost(raw);
    if (h && keep(h) && !out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

export interface PolicyFiles {
  official: z.infer<typeof OfficialDomainsFile>;
  sources: z.infer<typeof SourcesFile>;
}

/** The files written for a country; `draft` null means government domains and UNESCO only. */
export function policyFiles(country: string, draft: SourcePolicyDraft | null): PolicyFiles {
  const cc = country.toUpperCase();
  const gov = defaultGovernmentDomains(cc);
  const blocked = [...new Set([...ALWAYS_BLOCKED, ...uniqueHosts(draft?.blocked ?? [], 10, (h) => !under(h, gov))])];
  const official = [...new Set([...gov, ...uniqueHosts(draft?.official ?? [], 8, (h) => !under(h, blocked) && !under(h, NOT_PRESS))])];
  const press = uniqueHosts(draft?.press ?? [], 15, (h) => !under(h, official) && !under(h, blocked) && !under(h, NOT_PRESS));
  return {
    official: OfficialDomainsFile.parse({ country: cc, domains: official }),
    sources: SourcesFile.parse({ country: cc, A: official, B: press, blocked }),
  };
}

export function hasPolicyFiles(root: string, country: string): boolean {
  const cc = country.toLowerCase();
  return existsSync(join(root, "config", "sources", `${cc}.json`)) || existsSync(join(root, "config", "official-domains", `${cc}.json`));
}

export interface DraftPolicyOptions {
  root: string;
  country: string;
  countryName: string;
  localLanguage: string;
  model: string;
}

/**
 * Drafts and writes the policy. A budget stop is rethrown (the build must stop); any other failure
 * writes the government-only fallback so the build can go on with tier-A government pages.
 */
export async function draftSourcePolicy(transport: MessagesTransport, gate: CallGate, opts: DraftPolicyOptions, log: Logger): Promise<{ files: string[]; drafted: boolean }> {
  const cc = opts.country.toUpperCase();
  let draft: SourcePolicyDraft | null = null;
  try {
    const result = await extract(transport, gate, {
      key: `policy/${cc}`,
      model: opts.model,
      system: loadPrompt("source-policy-system.md"),
      context: `Country: ${opts.countryName} (${cc}). Main local language: ${opts.localLanguage}.`,
      citations: [],
      schema: SourcePolicyDraft,
      maxTokens: 2000,
    });
    if (result.ok && result.value.country.toUpperCase() === cc) draft = result.value;
    else log.warn(`policy ${cc}: draft unusable (${result.ok ? `answered for ${result.value.country}` : `${result.reason} ${result.detail}`}); government domains only`);
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    // classifyApiError rethrows anything that is not an API error (a bug); bad credentials stop too.
    const failure = classifyApiError(error);
    if (failure.kind === "fatal") throw error;
    log.warn(`policy ${cc}: ${failure.kind}: ${failure.message}; government domains only`);
  }
  const files = policyFiles(cc, draft);
  const lc = cc.toLowerCase();
  const officialPath = join(opts.root, "config", "official-domains", `${lc}.json`);
  const sourcesPath = join(opts.root, "config", "sources", `${lc}.json`);
  writeJson(officialPath, files.official);
  writeJson(sourcesPath, files.sources);
  log.info(`policy ${cc}: ${files.official.domains.length} official, ${files.sources.B.length} press, ${files.sources.blocked.length} blocked domain(s)${draft ? "" : " (fallback)"}`);
  return { files: [officialPath, sourcesPath], drafted: draft !== null };
}
