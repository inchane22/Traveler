// What the two calls are told about a queued festival. Only our own approved data goes here;
// web text enters the extraction call fenced, through extract.ts.
import { resolveRule } from "../../src/dates.ts";
import { ctxFor } from "../../src/festivals.ts";
import type { CountryFile } from "../../src/schema.ts";
import { fence } from "./extract.ts";
import { loadPrompt } from "./io.ts";
import { countryInfo, langFor, needsNewsSweep, newsTerms } from "./lang.ts";
import type { QueueItem } from "./queue.ts";
import { currentValue } from "./validate.ts";

const CRITERIA = ["convocatoria", "calle", "reconocimiento", "conectividad", "local"] as const;

function currentLines(item: QueueItem, country: CountryFile): string {
  const e = item.festival.editions[String(item.year)];
  const lines: string[] = [];
  if (e) {
    lines.push(`- status: ${e.status} (confidence ${e.confidence})`);
    lines.push(`- start: ${e.start ?? "none"}; end: ${e.end ?? "none"}`);
    for (const k of e.key_events) lines.push(`- key event ${k.id}: ${k.date ?? "no date"}`);
    for (const s of e.sources) lines.push(`- stored source: ${s.url}`);
    if (e.last_verified) lines.push(`- last verified: ${e.last_verified}`);
  } else {
    lines.push("- no stored edition for this year");
  }
  const resolved = resolveRule(item.festival.rule, item.year, ctxFor(country));
  if (resolved) {
    const w = resolved.kind === "window" ? resolved.window : resolved;
    lines.push(`- usual timing from past editions (not a source, do not report it as a fact): ${w.start} to ${w.end}`);
  }
  return lines.join("\n");
}

/** Facts the follow-up search can be asked for: the ones that put an edition on the calendar. */
export type FollowupFact = "start" | "end" | "status";

const FACT_LINES: Record<FollowupFact, string> = {
  start: "- start: first day of the festival",
  end: "- end: last day of the festival",
  status: "- status: confirmed by the organizer, still to be announced, postponed or cancelled",
};

/**
 * The research turn. With `followup`, the second, wider search after a first pass that cited
 * official pages but did not state these facts: it asks for them only.
 */
export function researchUserPrompt(item: QueueItem, country: CountryFile, followup?: readonly FollowupFact[]): string {
  const lang = langFor(country.country);
  const e = item.festival.editions[String(item.year)];
  const keyEvents = e?.key_events.length ? e.key_events.map((k) => k.name.es).join(", ") : "none stored, report the main ones";
  const news = needsNewsSweep(item.daysToStart)
    ? `- news from the last 30 days about this edition that use the words ${newsTerms(lang).map((t) => `«${t}»`).join(", ")}`
    : "";
  const countryName = countryInfo(country.country)?.names.en ?? country.country;
  const facts = followup?.length
    ? followup.map((f) => FACT_LINES[f])
    : [
        FACT_LINES.start,
        FACT_LINES.end,
        FACT_LINES.status,
        `- key events with their dates: ${keyEvents}`,
        "- attendance of the last completed edition, with its year and who measured it",
        "- UNESCO Intangible Cultural Heritage inscription or national heritage declaration",
      ];
  // Stored names came from an onboarding draft: fenced like any web text (SEC-07).
  return loadPrompt("research-user.md", {
    name_local: fence(item.festival.names.local),
    name_es: fence(item.festival.names.es),
    name_en: fence(item.festival.names.en),
    city: fence(item.festival.city),
    country_name: countryName,
    country: country.country,
    year: String(item.year),
    lang,
    current: currentLines(item, country),
    facts: facts.join("\n"),
    news,
    followup: followup?.length ? loadPrompt("research-followup.md", { country_name: countryName, year: String(item.year) }) : "",
  });
}

/** Stored record the extraction compares against, as JSON written by code. */
export function extractionContext(item: QueueItem): string {
  const e = item.festival.editions[String(item.year)];
  const stored = {
    country: item.country,
    slug: item.slug,
    edition: item.year,
    names: item.festival.names,
    city: item.festival.city,
    stored: {
      start: e?.start ?? null,
      end: e?.end ?? null,
      status: e?.status ?? null,
      confidence: e?.confidence ?? null,
      key_events: (e?.key_events ?? []).map((k) => ({ id: k.id, name: k.name.es, date: k.date ?? null })),
      score: Object.fromEntries(CRITERIA.map((c) => [c, currentValue(item.festival, item.year, `score.${c}`)])),
    },
  };
  return [
    `Propuesta pedida: country=${item.country}, slug=${item.slug}, edition=${item.year}.`,
    "Registro aprobado hoy (datos propios):",
    "```json",
    JSON.stringify(stored, null, 2),
    "```",
  ].join("\n");
}
