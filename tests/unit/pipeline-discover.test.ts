// A living calendar (2026-11-10): the pipeline builds every coverage country (all of Latin America)
// without anyone asking, and keeps looking for parties a live country's file does not have yet.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChangelogEntry, CountryFile, type Festival } from "../../src/schema.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { replayTransport } from "../../scripts/lib/client.ts";
import { discoveryEntries, runDiscover, sameFestival, selectNew } from "../../scripts/lib/discover-run.ts";
import { loadDomainPolicy } from "../../scripts/lib/domains.ts";
import { hasDateReader, quoteStatesDate } from "../../scripts/lib/date-parser.ts";
import { memoryLogger, readJson } from "../../scripts/lib/io.ts";
import { countryInfo, localLangFor } from "../../scripts/lib/lang.ts";
import type { LedgerEntry } from "../../scripts/lib/ledger.ts";
import { mapFestival, type DraftFestival, type MappedFestival } from "../../scripts/lib/onboard-draft.ts";
import { runPipeline } from "../../scripts/lib/pipeline-run.ts";
import { discoverDue, discoverKey as discoverKeyFor, makePlan, monthlyUpkeep, type PipelineSettings } from "../../scripts/lib/plan.ts";
import { coverageDue, type CountryRequest } from "../../scripts/lib/requests.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { cite, config, country, json, message, readJsonFile, REPO, search, tempRepo, text, usage } from "../fixtures/pipeline/helpers.ts";
import { fest, nation } from "../fixtures/pipeline/synthetic.ts";

const settings = readJson(join(REPO, "config", "pipeline.json")) as PipelineSettings;
const DAY = "2026-11-10";
const line = (over: Partial<LedgerEntry>): LedgerEntry => ({ day: "2026-11-02", job: "discover", key: "discover/AA", call: "research", model: "m", searches: 0, input_tokens: 0, output_tokens: 0, usd: 0.5, ...over });

describe("coverage: Latin America is built without anyone asking", () => {
  test("config lists every Latin American country, the three live ones included", () => {
    for (const cc of ["AR", "BO", "BR", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN", "HT", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"]) {
      expect(settings.coverage, cc).toContain(cc);
    }
  });

  test("every coverage country has facts and a date reader for the language its press writes in", () => {
    for (const cc of settings.coverage ?? []) {
      const info = countryInfo(cc);
      expect(info, cc).not.toBeNull();
      expect(hasDateReader(info!.local), `${cc} ${info!.local}`).toBe(true);
    }
    // CLDR alone says Guaraní and Haitian Creole, which no date reader knows: every date found there was held.
    expect(localLangFor("PY")).toBe("es");
    expect(localLangFor("HT")).toBe("fr");
    expect(quoteStatesDate("Le carnaval national se tiendra du 14 au 16 février 2027 à Port-au-Prince.", "fr", "2027-02-14", "start")).toBe(true);
  });

  test("a coverage country that is not live and was never asked for is due; queued and retrying ones keep their turn", () => {
    const req = (country: string, status: CountryRequest["status"], last_attempt?: string): CountryRequest => ({ country, requested_at: "2026-10-01", status, attempts: 1, ...(last_attempt ? { last_attempt } : {}) });
    const requests = [req("BO", "retry", "2026-11-09"), req("MX", "queued"), req("HT", "gave_up", "2026-10-01"), req("NI", "gave_up", "2026-06-01")];
    const live = new Set(["CO", "BR", "PE"]);
    // AR has no request; NI gave up more than 90 days ago, HT only 40 days ago.
    expect(coverageDue(requests, ["CO", "AR", "BO", "MX", "HT", "NI", "ar"], live, DAY, 90)).toEqual(["AR", "NI"]);
    expect(coverageDue(requests, [], live, DAY, 90)).toEqual([]);
  });

  test("the daily plan queues the uncovered countries itself and builds them within the new-country share", async () => {
    const root = tempRepo({ countries: ["co", "pe"], pipeline: { coverage: ["CO", "PE", "AR", "UY"] } });
    // As before anything was built for them: no domain config either.
    for (const cc of ["ar", "uy"]) for (const dir of ["sources", "official-domains"]) rmSync(join(root, "config", dir, `${cc}.json`), { force: true });
    const store = memoryUsageStore();
    const result = await runPipeline(
      { root, today: DAY, model: "claude-sonnet-5-5", budgetUsd: 20, maxFestivals: 40, maxFollowups: 0, planOnly: true },
      { transport: replayTransport({}), archiver: noopArchiver, usage: store, ledger: () => store.entries, log: memoryLogger() },
    );
    expect(result.summary.covered).toEqual(["AR", "UY"]);
    // A build from nothing is about US$3.33 and the new-country share of US$20 is US$6: one today,
    // the other waits for next month's share (the rest of coverage likewise, a few a month).
    expect(result.plan.builds.map((b) => [b.country, b.hasFile, b.needsPolicy])).toEqual([["AR", false, true]]);
    expect(result.plan.waiting).toEqual([expect.objectContaining({ country: "UY", reason: "budget", until: "2026-12-01" })]);
    expect(readFileSync(join(root, "proposals", `pipeline-${DAY}.md`), "utf8")).toContain("Coverage: AR, UY queued by the pipeline itself");
    // A plan writes no state.
    expect(store.entries).toEqual([]);
  });
});

describe("discovery cadence (plan.ts)", () => {
  const live = (cc: string, n: number) => nation(cc, Array.from({ length: n }, (_, i) => fest(cc, `${cc.toLowerCase()}-f${i}`, { type: "fixed", start: "03-01", end: "03-02" })));

  test("every live country is looked at again after discover_every_days; never looked first, then the smallest", () => {
    const countries = [live("AA", 5), live("BB", 2), { ...live("CC", 1), status: "borrador" as const }, live("DD", 3)];
    expect(discoverDue(countries, [], DAY, 60)).toEqual(["BB", "DD", "AA"]);
    const ledger = [line({ key: "discover/BB", day: "2026-11-01" }), line({ key: "onboard/DD", job: "onboard", day: "2026-08-01" }), line({ key: "discover/AA", job: "build", day: "2026-09-01" })];
    // BB 9 days ago: not due. DD onboarded 101 days ago: due. AA looked 70 days ago (inside a build): due, after DD.
    expect(discoverDue(countries, ledger, DAY, 60)).toEqual(["DD", "AA"]);
  });

  const planFor = (today: string, budgetUsd: number, countries: CountryFile[], ledger: LedgerEntry[] = []) =>
    makePlan({ today, budgetUsd, settings, countries, config, requests: [], ledger, configured: new Set(), maxFestivals: 40 });

  test("discoveries come from their own share, up to the per-run limit", () => {
    const countries = [live("AA", 5), live("BB", 2), live("DD", 3)];
    const plan = planFor(DAY, 100, countries);
    expect(plan.discover).toEqual(["BB", "DD"]);
    expect(plan.deferred).toContainEqual({ country: "AA", band: "discover" });
    // Upkeep spent to the last cent does not stop them: the money is set aside.
    const upkeepGone = planFor(DAY, 100, countries, [line({ job: "verify", key: "AA/x", usd: 64.9, day: "2026-11-01" })]);
    expect(upkeepGone.discover).toEqual(["BB", "DD"]);
    // The discovery share spent: none runs, all wait.
    const spent = planFor(DAY, 100, countries, [line({ key: "discover/ZZ", usd: 15, day: "2026-11-01" })]);
    expect(spent.discover).toEqual([]);
  });

  test("at US$20 a discovery costs more than a day of upkeep, and still runs, paced through the month", () => {
    const many = ["AR", "BO", "CL", "CR", "CU", "DO", "EC", "GT", "HN", "HT", "MX", "NI", "PA", "PY", "SV", "UY", "VE", "BR", "CO", "PE", "PR"].map((cc) => live(cc, 5));
    const first = planFor("2026-12-01", 20, many);
    expect(first.budget.todayUpkeep).toBeLessThan(first.costs.discover);
    expect(first.discover).toHaveLength(1);
    // One discovery (US$0.70) on the 1st: the US$3 share's pace (US$0.10 a day) has not caught up on
    // the 5th, so nothing runs; by the 8th it has, so the next one runs.
    const ran = [line({ key: discoverKeyFor(first.discover[0]!), day: "2026-12-01", usd: 0.7 })];
    expect(planFor("2026-12-05", 20, many, ran).discover).toEqual([]);
    expect(planFor("2026-12-08", 20, many, ran).discover).toHaveLength(1);
    // About four a month: each of the 21 countries is searched roughly every five months.
    expect(first.projection.discoverCycleDays).toBe(Math.ceil((30 * 21 * first.costs.discover) / 3));
  });

  test("a bigger budget searches every country every discover_every_days", () => {
    const plan = planFor("2026-12-01", 200, [country("CO")]);
    expect(plan.projection.discoverCycleDays).toBe(settings.discover_every_days);
    // Discovery is not part of the upkeep projection any more: it has its own money.
    expect(plan.projection.monthlyUpkeep).toBeCloseTo(monthlyUpkeep([country("CO")], config, plan.costs, "2026-12-01", 1), 1);
  });
});

describe("which candidates are new (sameFestival, selectNew)", () => {
  const named = (slug: string, es: string, city: string, type: Festival["type"] = "carnaval"): Festival => ({ ...fest("CO", slug, { type: "fixed", start: "01-01", end: "01-02" }), names: { local: es, es, en: es, pt: es }, city });

  test("the same festival under another name or year is caught; a different one in the same city is not", () => {
    const barranquilla = named("carnaval-barranquilla", "Carnaval de Barranquilla", "Barranquilla");
    expect(sameFestival(barranquilla, named("carnaval-de-barranquilla-2027", "Carnaval de Barranquilla 2027", "Barranquilla"))).toBe(true);
    expect(sameFestival(barranquilla, named("x", "Carnaval de Barranquilla", "Soledad"))).toBe(true);
    expect(sameFestival(named("feria-de-cali", "Feria de Cali", "Cali", "musica"), named("salsodromo", "Salsódromo de la Feria de Cali", "Cali", "musica"))).toBe(true);
    expect(sameFestival(named("feria-de-cali", "Feria de Cali", "Cali", "musica"), named("petronio", "Festival Petronio Álvarez", "Cali", "musica"))).toBe(false);
    expect(sameFestival(barranquilla, named("carnaval-riosucio", "Carnaval de Riosucio", "Riosucio"))).toBe(false);
  });

  const policy = loadDomainPolicy(REPO, "CO");
  const mapped = (f: Festival, over: Partial<MappedFestival> = {}): MappedFestival => ({
    festival: f,
    verified: ["dates", "score.fiesta"],
    porMedir: [],
    sources: [{ url: "https://www.eltiempo.com/x", host: "eltiempo.com", domain: "eltiempo.com", tier: "B", official: false, title: null }],
    candidateSource: "prensa",
    datedEdition: true,
    ...over,
  });
  const co = nation("CO", [named("carnaval-barranquilla", "Carnaval de Barranquilla", "Barranquilla")]);

  test("only new parties with a cited party level and an A/B-sourced date or rule join, best first, up to the limit", () => {
    const solemn = { ...named("semana-santa-popayan", "Semana Santa de Popayán", "Popayán", "fiesta_popular"), score: { ...named("a", "a", "a").score, fiesta: { measure: "solemne" as const, confidence: "estimacion" as const } } };
    const unclassified = { ...named("fiesta-sin-fuente", "Fiesta sin fuente", "Pasto"), score: { ...named("a", "a", "a").score, fiesta: null } };
    const best = { ...named("mono-nunez", "Festival Mono Núñez", "Ginebra", "musica"), score: { ...named("a", "a", "a").score, viajeros: { measure: "internacional" as const, confidence: "estimacion" as const } } };
    const result = selectNew(
      co,
      new Set(["carnaval-barranquilla", "taken-elsewhere"]),
      [
        mapped(named("carnaval-de-barranquilla", "Carnaval de Barranquilla", "Barranquilla")),
        mapped(solemn),
        mapped(unclassified),
        mapped(named("sin-fecha", "Fiesta sin fecha", "Tunja"), { datedEdition: false, verified: ["score.fiesta"] }),
        mapped(named("solo-blog", "Fiesta del blog", "Neiva"), { sources: [{ url: "https://blog.example/x", host: "blog.example", domain: "blog.example", tier: "C", official: false, title: null }] }),
        mapped(named("taken-elsewhere", "Fiesta repetida", "Ibagué")),
        mapped(named("tercera", "Tercera fiesta", "Cúcuta")),
        mapped(best),
      ],
      config,
      policy,
      DAY,
      2,
    );
    expect(result.added.map((f) => f.slug)).toEqual(["mono-nunez", "taken-elsewhere-ibague"]);
    const why = result.skipped.join("\n");
    expect(why).toMatch(/Carnaval de Barranquilla \(Barranquilla\): already on the calendar as carnaval-barranquilla/);
    expect(why).toMatch(/Semana Santa de Popayán.*solemn act/);
    expect(why).toMatch(/Fiesta sin fuente.*what visitors do there/);
    expect(why).toMatch(/Fiesta sin fecha.*no cited date or date rule/);
    expect(why).toMatch(/Fiesta del blog.*only tier-C sources/);
    expect(why).toMatch(/Tercera fiesta.*over this run's limit of 2/);
  });

  test("a new festival enters the changelog as «festival», with its sources", () => {
    const f = { ...named("mono-nunez", "Festival Mono Núñez", "Ginebra", "musica"), editions: { "2027": { start: "2027-06-03", end: "2027-06-06", status: "tentativa" as const, confidence: "prensa" as const, key_events: [], sources: [{ url: "https://www.eltiempo.com/mono", publisher: "eltiempo.com", accessed: DAY, tier: "B" as const, quote: "del 3 al 6 de junio de 2027" }], sequence: 0 } } };
    expect(discoveryEntries("CO", [f], DAY)).toEqual([{ date: DAY, country: "CO", slug: "mono-nunez", field: "festival", old: null, new: "Festival Mono Núñez", source_urls: ["https://www.eltiempo.com/mono"] }]);
  });
});

// Recorded responses for one discovery in Colombia: the research cites a national paper (B) and a
// government page (A) about a festival the file lacks, plus the Barranquilla carnival it already has.
const MONO = "https://www.eltiempo.com/cultura/musica/festival-mono-nunez-2027-fechas";
const MONO_TEXT = "El Festival Mono Núñez se celebrará del 3 al 6 de junio de 2027 en Ginebra, Valle del Cauca.";
const MONO_PARTY = "Durante cuatro días la música andina llena el parque y las calles de Ginebra, donde visitantes bailan y cantan hasta la madrugada.";
const MONO_TRAVEL = "El festival recibe visitantes de todo el país y de otros países de América.";
const BAQ = "https://www.carnavaldebarranquilla.org/fechas-2027";
const BAQ_TEXT = "El Carnaval de Barranquilla 2027 será del 6 al 9 de febrero.";
const CO_DRAFT = (festivals: unknown[]) => ({ country: "CO", festivals, not_found: [] });
const evidence = (source_url: string, quote: string) => ({ source_url, quote, quote_language: "es" });
const rule = (over: Partial<DraftFestival["rule"]> = {}): DraftFestival["rule"] => ({ type: "announced", start_month_day: "05-25", end_month_day: "06-15", easter_calendar: null, easter_start_offset: null, easter_end_offset: null, month: null, weekday: null, n: null, duration_days: null, parity: null, ...over });
const draftFestival = (over: Partial<DraftFestival>): DraftFestival => ({
  slug: "festival-mono-nunez",
  names: { local: "Festival Mono Núñez", es: "Festival Mono Núñez", en: "Mono Núñez Festival", pt: "Festival Mono Núñez" },
  city: "Ginebra",
  subdivision: "CO-VAC",
  timezone: "America/Bogota",
  coords: { lat: 3.7244, lon: -76.2669 },
  nearest_airport: "CLO",
  type: "musica",
  candidate_source: "prensa",
  rule: rule(),
  rule_evidence: null,
  next_edition: { year: 2027, start: "2027-06-03", end: "2027-06-06", status: "tentativa", confidence: "prensa", evidence: evidence(MONO, MONO_TEXT) },
  attendance: null,
  party: { level: "baile_abierto", evidence: evidence(MONO, MONO_PARTY) },
  travelers: { level: "nacional", evidence: evidence(MONO, MONO_TRAVEL) },
  street: null,
  connectivity: null,
  ...over,
});

function discoveryTransport() {
  return replayTransport({
    "discover/CO": {
      research: [
        message(
          [
            ...search("festivales Colombia 2027 música baile", [MONO, BAQ]),
            text("Festival Mono Núñez: del 3 al 6 de junio de 2027, en Ginebra.", [cite(MONO, MONO_TEXT), cite(MONO, MONO_PARTY), cite(MONO, MONO_TRAVEL)]),
            text("Carnaval de Barranquilla: del 6 al 9 de febrero de 2027.", [cite(BAQ, BAQ_TEXT)]),
          ],
          "end_turn",
          usage(30000, 900, 2),
        ),
      ],
      extract: [
        json(
          CO_DRAFT([
            draftFestival({}),
            draftFestival({
              slug: "carnaval-de-barranquilla",
              names: { local: "Carnaval de Barranquilla", es: "Carnaval de Barranquilla", en: "Barranquilla Carnival", pt: "Carnaval de Barranquilla" },
              city: "Barranquilla",
              subdivision: "CO-ATL",
              type: "carnaval",
              next_edition: { year: 2027, start: "2027-02-06", end: "2027-02-09", status: "confirmada", confidence: "oficial", evidence: evidence(BAQ, BAQ_TEXT) },
              party: { level: "baile_abierto", evidence: evidence(BAQ, BAQ_TEXT) },
              travelers: null,
            }),
            // A paraphrase is no evidence: nothing about it can be verified, so it is not added.
            draftFestival({ slug: "fiesta-inventada", names: { local: "Fiesta Inventada", es: "Fiesta Inventada", en: "Made-up Fiesta", pt: "Festa Inventada" }, city: "Neiva", subdivision: "CO-HUI", party: { level: "baile_abierto", evidence: evidence(MONO, "la gente baila") }, next_edition: null, travelers: null }),
          ]),
        ),
      ],
    },
  });
}

describe("discovery run with recorded responses", () => {
  test("a new festival with cited dates joins the live country, with a changelog entry and a report; known ones are skipped", async () => {
    const root = tempRepo({ countries: ["co"] });
    const store = memoryUsageStore();
    const transport = discoveryTransport();
    const before = CountryFile.parse(readJsonFile(join(root, "data", "countries", "co.json")));
    const result = await runDiscover({ root, country: "CO", today: DAY, model: "claude-sonnet-5-5", budgetUsd: 20, maxNew: 3 }, { transport, usage: store, log: memoryLogger() });
    expect(result.exitCode).toBe(0);
    // The research prompt lists what the calendar already has, fenced.
    const user = transport.calls[0]!.params.messages[0]!.content as string;
    expect(user).toContain("<known>");
    expect(user).toContain("- Carnaval de Barranquilla (Barranquilla)");

    const after = CountryFile.parse(readJsonFile(join(root, "data", "countries", "co.json")));
    expect(after.festivals.length).toBe(before.festivals.length + 1);
    expect(after.festivals.slice(0, -1)).toEqual(before.festivals);
    const added = after.festivals.at(-1)!;
    expect(added).toMatchObject({ slug: "festival-mono-nunez", city: "Ginebra", type: "musica", score: { fiesta: { measure: "baile_abierto", confidence: "prensa", source: MONO }, viajeros: { measure: "nacional" } } });
    expect(added.editions["2027"]).toMatchObject({ start: "2027-06-03", end: "2027-06-06", status: "tentativa", sources: [{ url: MONO, tier: "B", quote: MONO_TEXT }] });

    const changelog = ChangelogEntry.array().parse(readJsonFile(join(root, "data", "changelog.json")));
    expect(changelog.at(-1)).toEqual({ date: DAY, country: "CO", slug: "festival-mono-nunez", field: "festival", old: null, new: "Festival Mono Núñez", source_urls: [MONO] });
    expect(result.report?.added.map((f) => f.slug)).toEqual(["festival-mono-nunez"]);
    expect(result.report?.skipped.join("\n")).toMatch(/Carnaval de Barranquilla.*already on the calendar as carnaval-barranquilla/);
    expect(result.report?.skipped.join("\n")).toMatch(/Fiesta Inventada.*what visitors do there/);
    expect(readFileSync(join(root, "proposals", `discover-co-${DAY}.md`), "utf8")).toContain("Festival Mono Núñez");
    // Spend is on record as a discovery of the country.
    expect(new Set(store.entries.map((e) => `${e.job} ${e.key}`))).toEqual(new Set(["discover discover/CO"]));
  });

  test("a dry run writes the report but not the data; at 80% of the month nothing is searched", async () => {
    const root = tempRepo({ countries: ["co"] });
    const before = readFileSync(join(root, "data", "countries", "co.json"), "utf8");
    const dry = await runDiscover({ root, country: "CO", today: DAY, model: "claude-sonnet-5-5", budgetUsd: 20, maxNew: 3, dryRun: true }, { transport: discoveryTransport(), usage: memoryUsageStore(), log: memoryLogger() });
    expect(dry.report?.added).toHaveLength(1);
    expect(readFileSync(join(root, "data", "countries", "co.json"), "utf8")).toBe(before);

    const transport = discoveryTransport();
    const spent = memoryUsageStore([{ month: "2026-11", searches: 0, input_tokens: 0, output_tokens: 0, usd: 16.5 }]);
    const late = await runDiscover({ root, country: "CO", today: DAY, model: "claude-sonnet-5-5", budgetUsd: 20, maxNew: 3 }, { transport, usage: spent, log: memoryLogger() });
    expect(late).toMatchObject({ exitCode: 0, report: null });
    expect(transport.calls).toEqual([]);
  });

  test("the daily pipeline runs the due discovery and reports the new festival in its summary and commit message", async () => {
    const root = tempRepo({ countries: ["co"], pipeline: { max_discover_per_run: 1 } });
    const store = memoryUsageStore();
    const result = await runPipeline(
      { root, today: DAY, model: "claude-sonnet-5-5", budgetUsd: 200, maxFestivals: 0, maxFollowups: 0, planOnly: false },
      { transport: discoveryTransport(), archiver: noopArchiver, usage: store, ledger: () => store.entries, log: memoryLogger() },
    );
    expect(result.plan.discover).toEqual(["CO"]);
    expect(result.summary.discovered.map((f) => `${f.country}/${f.slug}`)).toEqual(["CO/festival-mono-nunez"]);
    expect(readFileSync(join(root, "proposals", "commit-message.txt"), "utf8")).toMatch(/· 1 new[\s\S]*- CO festival-mono-nunez: Festival Mono Núñez, Ginebra \(https:\/\/www\.eltiempo\.com/);
    expect(readFileSync(join(root, "proposals", `pipeline-${DAY}.md`), "utf8")).toContain("New on the calendar: CO Festival Mono Núñez (Ginebra).");
    // The next day it is not due again.
    const next = makePlan({ today: "2026-11-11", budgetUsd: 200, settings: { ...settings, max_discover_per_run: 1 }, countries: [CountryFile.parse(readJsonFile(join(root, "data", "countries", "co.json")))], config, requests: [], ledger: store.entries, configured: new Set(["CO"]), maxFestivals: 0 });
    expect(next.discover).toEqual([]);
  });
});

describe("mapping keeps discovery honest", () => {
  test("a candidate whose quote is not in the cited text has no verified party level", () => {
    const m = mapFestival(draftFestival({ party: { level: "baile_abierto", evidence: evidence(MONO, "texto que no está en la cita") } }), "CO", "America/Bogota", { citations: [cite(MONO, MONO_TEXT)], policy: loadDomainPolicy(REPO, "CO") }, DAY);
    expect("error" in m).toBe(false);
    expect((m as MappedFestival).festival.score.fiesta).toBeNull();
  });
});
