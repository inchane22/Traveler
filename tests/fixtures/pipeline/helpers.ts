// Shared test helpers for the AI pipeline suites: a throwaway copy of the repo data (tests never
// touch data/countries/*.json) and small builders for Messages API responses.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCountries } from "../../../scripts/build-data.ts";
import type { Message } from "../../../scripts/lib/client.ts";
import { loadDomainPolicy } from "../../../scripts/lib/domains.ts";
import type { RefreshOptions } from "../../../scripts/lib/refresh-run.ts";
import type { Citation } from "../../../scripts/lib/research.ts";
import { CountryFile, type Festival } from "../../../src/schema.ts";
import type { ScoringConfig } from "../../../src/score.ts";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = join(REPO, "tests", "fixtures", "pipeline");
/** One `--fixtures` dir serves both CLIs: `<cc>/<slug>.json` for refresh, `onboard/<cc>.json` for onboarding. */
export const REFRESH_FIXTURES = FIXTURES;
export const TODAY = "2026-10-26";

export const config = JSON.parse(readFileSync(join(REPO, "config", "scoring.json"), "utf8")) as ScoringConfig;
export const coPolicy = loadDomainPolicy(REPO, "CO");

export function countries(): CountryFile[] {
  return loadCountries(join(REPO, "data", "countries"));
}

/** One country file only, so a file another change is still editing cannot break unrelated tests. */
export function country(cc: string): CountryFile {
  return CountryFile.parse(JSON.parse(readFileSync(join(REPO, "data", "countries", `${cc.toLowerCase()}.json`), "utf8")));
}

export function festival(cc: string, slug: string): Festival {
  const found = country(cc).festivals.find((f) => f.slug === slug);
  if (!found) throw new Error(`no festival ${cc}/${slug}`);
  return found;
}

/** Copy of config/ and data/ in a temp dir. `countries` limits which country files are copied. */
export function tempRepo(opts: { countries?: readonly string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "traveler-pipeline-"));
  cpSync(join(REPO, "config"), join(root, "config"), { recursive: true });
  mkdirSync(join(root, "data", "countries"), { recursive: true });
  for (const cc of opts.countries ?? ["bo", "co", "pe"]) {
    cpSync(join(REPO, "data", "countries", `${cc}.json`), join(root, "data", "countries", `${cc}.json`));
  }
  cpSync(join(REPO, "data", "changelog.json"), join(root, "data", "changelog.json"));
  writeFileSync(join(root, "data", "usage.json"), "[]\n");
  return root;
}

export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

let counter = 0;

export function usage(input = 1000, output = 200, searches = 0): Message["usage"] {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: input,
    output_tokens: output,
    server_tool_use: searches ? { web_fetch_requests: 0, web_search_requests: searches } : null,
    service_tier: "standard",
  } as unknown as Message["usage"];
}

export function message(content: unknown[], stop: Message["stop_reason"] = "end_turn", u: Message["usage"] = usage(), stopDetails: unknown = null): Message {
  counter += 1;
  return {
    id: `msg_test_${counter}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stopDetails,
    container: null,
    usage: u,
  } as unknown as Message;
}

export function text(t: string, cites: readonly Citation[] = []): unknown {
  return {
    type: "text",
    text: t,
    citations: cites.length
      ? cites.map((c) => ({ type: "web_search_result_location", url: c.url, title: c.title, cited_text: c.cited_text, encrypted_index: "FAKE" }))
      : null,
  };
}

export function search(query: string, results: readonly string[] | { error: string }): unknown[] {
  counter += 1;
  const id = `srvtoolu_test_${counter}`;
  const content = Array.isArray(results)
    ? results.map((url) => ({ type: "web_search_result", url, title: url, encrypted_content: "FAKE", page_age: null }))
    : { type: "web_search_tool_result_error", error_code: (results as { error: string }).error };
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query }, caller: { type: "direct" } },
    { type: "web_search_tool_result", tool_use_id: id, content, caller: { type: "direct" } },
  ];
}

export function json(value: unknown, stop: Message["stop_reason"] = "end_turn"): Message {
  return message([text(JSON.stringify(value))], stop);
}

export function cite(url: string, cited_text: string, title: string | null = "t"): Citation {
  return { url, title, cited_text };
}

/** Dry run over CO with the documented defaults; override per test. */
export function refreshOptions(root: string, over: Partial<RefreshOptions> = {}): RefreshOptions {
  return { root, dryRun: true, today: TODAY, model: "claude-sonnet-5-5", country: "CO", maxFestivals: 40, perCountry: 10, budgetUsd: 20, ...over };
}

/** `key=value` lines of a $GITHUB_OUTPUT file. */
export function githubOutput(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
