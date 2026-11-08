import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CountryFile } from "../../src/schema.ts";
import { dataProblems, loadCountries } from "../../scripts/build-data.ts";
import { main as onboardMain } from "../../scripts/onboard.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport, loadFixtureSet, replayTransport } from "../../scripts/lib/client.ts";
import { emptyPolicy, loadDomainPolicy, withGovernmentFallback } from "../../scripts/lib/domains.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { mapFestival, OnboardingDraft, probableWindow, slugify, toRule, verifyEvidence, type DraftFestival, type MappedFestival } from "../../scripts/lib/onboard-draft.ts";
import { onboardFlags, runOnboard, type OnboardOptions } from "../../scripts/lib/onboard-run.ts";
import { cite, FIXTURES, githubOutput, json, message, readJsonFile, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";

const PE_FIXTURE = join(FIXTURES, "onboard", "pe.json");
const recorded = loadFixtureSet(PE_FIXTURE);
const draft = OnboardingDraft.parse(JSON.parse((recorded.extract[0]!.content[0] as { text: string }).text));
const opts = (root: string, over: Partial<OnboardOptions> = {}): OnboardOptions => ({ root, country: "PE", dryRun: false, today: TODAY, model: "claude-sonnet-5-5", budgetUsd: 20, ...over });
const deps = (over = {}) => ({ transport: fixtureDirTransport(FIXTURES), usage: memoryUsageStore(), log: memoryLogger(), ...over });
/** A repo copy as before PE is onboarded: no data file and no domain config for it. */
const freshRoot = () => {
  const root = tempRepo({ countries: ["co"] });
  for (const dir of ["sources", "official-domains"]) rmSync(join(root, "config", dir, "pe.json"), { force: true });
  return root;
};

describe("onboarding PE with recorded responses (H5 acceptance)", () => {
  test("every unverified field ends up «por medir» or «por anunciar», and the draft validates", async () => {
    const root = freshRoot();
    const out = join(root, "gh");
    writeFileSync(out, "");
    const result = await runOnboard(opts(root, { githubOutput: out }), deps());
    expect(result.exitCode).toBe(0);

    const file = CountryFile.parse(readJsonFile(join(root, "data", "countries", "pe.json")));
    expect(file).toMatchObject({ country: "PE", status: "borrador", timezone: "America/Lima", region: "sudamerica", generated_at: TODAY });
    const bySlug = Object.fromEntries(file.festivals.map((f) => [f.slug, f]));
    expect(Object.keys(bySlug).sort()).toEqual(["candelaria-puno", "carnaval-cajamarca", "inti-raymi", "senor-de-los-milagros"]);

    // Nothing in these two had a validated citation: all «por medir», no edition, rule only «announced».
    for (const slug of ["senor-de-los-milagros", "carnaval-cajamarca"]) {
      const f = bySlug[slug]!;
      expect(Object.values(f.score).every((v) => v === null), slug).toBe(true);
      expect(f.editions).toEqual({});
      expect(f.rule.type).toBe("announced");
    }
    // Candelaria: UNESCO and the dates are cited; attendance (uncited URL) and connectivity (paraphrase) are not.
    const candelaria = bySlug["candelaria-puno"]!;
    expect(candelaria.score).toMatchObject({ convocatoria: null, conectividad: null, calle: null, reconocimiento: { measure: "unesco", confidence: "oficial" } });
    expect(candelaria.editions["2027"]).toMatchObject({ start: "2027-02-01", end: "2027-02-14", status: "tentativa", confidence: "oficial", last_verified: TODAY });
    expect(candelaria.rule).toEqual({ type: "announced", window: { start: "01-25", end: "02-20" } });
    // Inti Raymi: the fixed rule and a press figure with its year are cited.
    const inti = bySlug["inti-raymi"]!;
    expect(inti.rule).toEqual({ type: "fixed", start: "06-24", end: "06-24" });
    // rpp.pe is tier C until a person writes config/sources/pe.json: an estimate, not «prensa» (BE-02).
    expect(inti.score.convocatoria).toMatchObject({ measure: { attendance: 60000, qualifier: "more_than", year: 2025 }, confidence: "estimacion" });

    const report = result.report!;
    expect(report.dropped).toEqual(["fiesta-sin-codigo: subdivision PUNO is not an ISO 3166-2 code of PE"]);
    expect(report.flags.messages.join()).toMatch(/R2: solo 2 fiesta/);
    expect(report.festivals.find((f) => f.slug === "carnaval-cajamarca")!.verified).toEqual([]);
    expect(githubOutput(out)).toEqual({ changes: "4", branch: "onboard/pe" });
    const md = readFileSync(join(root, "proposals", `onboard-pe-${TODAY}.md`), "utf8");
    expect(md).toContain("«por medir»");
    expect(md).toContain("Descartadas (1)");
    // One open research pass (no allow-list for a new country), then one extraction.
    expect(result.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["data/countries/pe.json", `proposals/onboard-pe-${TODAY}.json`, `proposals/onboard-pe-${TODAY}.md`]);
  });

  test("the draft passes build-data without hand-written config, and the domain checks return once it is «publicado» (BE-02)", async () => {
    const root = freshRoot();
    expect((await runOnboard(opts(root), deps())).exitCode).toBe(0);
    const loaded = loadCountries(join(root, "data", "countries"));
    const policies = new Map(loaded.map((c) => [c.country, loadDomainPolicy(root, c.country)]));
    expect(dataProblems(loaded, policies, TODAY)).toEqual([]);
    const published = loaded.map((c) => (c.country === "PE" ? { ...c, status: "publicado" as const } : c));
    expect(dataProblems(published, policies, TODAY).join("\n")).toMatch(/PE\/candelaria-puno 2027: .* declares tier A, config\/sources gives C/);
  });

  test("--dry-run writes only the proposals; an existing country is never overwritten", async () => {
    const root = tempRepo();
    const before = readFileSync(join(root, "data", "countries", "pe.json"), "utf8");
    const dry = await runOnboard(opts(root, { dryRun: true }), deps());
    expect(dry.exitCode).toBe(0);
    expect(dry.files.every((f) => f.includes("proposals"))).toBe(true);
    expect(readFileSync(join(root, "data", "countries", "pe.json"), "utf8")).toBe(before);
    const log = memoryLogger();
    expect((await runOnboard(opts(root), deps({ log }))).exitCode).toBe(1);
    expect(log.lines.join()).toMatch(/never overwrites a country/);
  });

  test("the research call is open (no allow-list) with the country's location and 15 searches", async () => {
    const transport = fixtureDirTransport(FIXTURES);
    await runOnboard(opts(freshRoot(), { dryRun: true }), deps({ transport }));
    const [researchCall, extractCall] = transport.calls;
    expect(researchCall!.ctx).toEqual({ key: "onboard/PE", kind: "research" });
    expect(researchCall!.params.tools![0]).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 15, user_location: { type: "approximate", country: "PE", timezone: "America/Lima" }, allowed_callers: ["direct"] });
    expect(extractCall!.params.output_config?.format?.type).toBe("json_schema");
    // Once config/sources/pe.json exists, its block list goes to the tool.
    const configured = tempRepo({ countries: ["co"] });
    if (existsSync(join(configured, "config", "sources", "pe.json"))) {
      const withConfig = fixtureDirTransport(FIXTURES);
      await runOnboard(opts(configured, { dryRun: true }), deps({ transport: withConfig }));
      const blocked = readJsonFile<{ blocked: string[] }>(join(configured, "config", "sources", "pe.json")).blocked;
      expect((withConfig.calls[0]!.params.tools![0] as { blocked_domains?: string[] }).blocked_domains).toEqual(blocked.length ? blocked : undefined);
    }
  });

  test("failures: unknown country, refusal, schema drop, wrong country, nothing left", async () => {
    const root = freshRoot();
    const run = async (o: Partial<OnboardOptions>, research: unknown[], extract: unknown[]) => {
      const log = memoryLogger();
      const transport = replayTransport({ "onboard/PE": { research: research as never, extract: extract as never } });
      const r = await runOnboard(opts(root, { dryRun: true, ...o }), deps({ transport, log }));
      return { ...r, text: log.lines.join("\n") };
    };
    expect((await run({ country: "ZZ" }, [], [])).text).toMatch(/no country facts/);
    expect((await run({}, [message([], "refusal")], [])).text).toMatch(/research refusal/);
    expect((await run({}, recorded.research, [json({ bad: 1 }), json({ bad: 2 })])).text).toMatch(/extraction dropped after 2/);
    expect((await run({}, recorded.research, [json({ ...draft, country: "BO" })])).text).toMatch(/the draft is for BO/);
    const none = await run({}, recorded.research, [json({ ...draft, festivals: [draft.festivals.at(-1)] })]);
    expect(none.exitCode).toBe(1);
    expect(none.text).toMatch(/no festival survived validation/);
    expect((await run({ budgetUsd: 0.0001 }, recorded.research, recorded.extract)).text).toMatch(/monthly budget reached/);
    expect((await run({}, [], [])).text).toMatch(/fixture: no recorded research/);
  });

  test("pnpm onboard -- --fixtures runs offline", async () => {
    const root = freshRoot();
    const log = memoryLogger();
    expect(await onboardMain(["--country=pe", "--dry-run", `--today=${TODAY}`, `--fixtures=${FIXTURES}`], {}, root, log)).toBe(0);
    expect(existsSync(join(root, "proposals", `onboard-pe-${TODAY}.json`))).toBe(true);
    expect(readFileSync(join(root, "data", "usage.json"), "utf8")).toBe("[]\n");
    expect(await onboardMain([], {}, root, memoryLogger())).toBe(2);
  });
});

describe("draft mapping", () => {
  const ctx = { citations: [cite("https://www.cultura.gob.pe/inti-raymi", "El Inti Raymi se celebra cada 24 de junio en Cusco.")], policy: withGovernmentFallback(emptyPolicy("PE")) };
  const inti = draft.festivals.find((f) => f.slug === "inti-raymi")!;
  const with_ = (over: Partial<DraftFestival>): DraftFestival => ({ ...inti, ...over });

  test("evidence counts only when cited, verbatim and clean", () => {
    const e = { source_url: "https://www.cultura.gob.pe/inti-raymi", quote: "cada 24 de junio", quote_language: "es" };
    expect(verifyEvidence(e, ctx)).toMatchObject({ confidence: "oficial" });
    expect(verifyEvidence({ ...e, quote: "cada 25 de junio" }, ctx)).toBeNull();
    expect(verifyEvidence({ ...e, source_url: "https://otro.pe/x" }, ctx)).toBeNull();
    expect(verifyEvidence(null, ctx)).toBeNull();
    // BE-02: «prensa» needs an A or B source; a tier-C page backs an estimate at most.
    const blog = { citations: [cite("https://blog.example.com/inti", "cada 24 de junio")], policy: ctx.policy };
    expect(verifyEvidence({ ...e, source_url: "https://blog.example.com/inti" }, blog)).toMatchObject({ confidence: "estimacion" });
    const press = { citations: blog.citations, policy: { ...ctx.policy, B: ["example.com"] } };
    expect(verifyEvidence({ ...e, source_url: "https://blog.example.com/inti" }, press)).toMatchObject({ confidence: "prensa" });
  });

  test("identity checks: slug fallback, subdivision, coordinates, names, zone and airport", () => {
    const ok = mapFestival(with_({ slug: "Inti Raymi!", timezone: "Mars/Olympus", nearest_airport: "cuzco" }), "PE", "America/Lima", ctx, TODAY) as MappedFestival;
    expect(ok.festival).toMatchObject({ slug: "inti-raymi", timezone: "America/Lima" });
    expect(ok.festival).not.toHaveProperty("nearest_airport");
    expect(mapFestival(with_({ coords: { lat: 99, lon: 0 } }), "PE", "America/Lima", ctx, TODAY)).toEqual({ error: "inti-raymi: coordinates out of range" });
    expect(mapFestival(with_({ city: " " }), "PE", "America/Lima", ctx, TODAY)).toEqual({ error: "inti-raymi: empty name or city" });
    expect(mapFestival(with_({ slug: "", names: { ...inti.names, es: "", local: "" } }), "PE", "America/Lima", ctx, TODAY)).toEqual({ error: ": no slug" });
    expect(slugify("Señor de los Milagros")).toBe("senor-de-los-milagros");
  });

  test("rules: flat draft rules map onto the schema; unverified ones become a probable window", () => {
    const flat = inti.rule;
    expect(toRule({ ...flat, type: "nth_weekday", month: 1, weekday: 5, n: 1, duration_days: 6, parity: "odd" })).toEqual({ type: "nth_weekday", month: 1, weekday: 5, n: 1, duration_days: 6, parity: "odd" });
    expect(toRule({ ...flat, type: "easter_offset", easter_calendar: "gregorian", easter_start_offset: -50, easter_end_offset: -47 })).toMatchObject({ type: "easter_offset" });
    expect(toRule({ ...flat, start_month_day: "13-40" })).toBeNull();
    expect(probableWindow(toRule(flat), 2027)).toEqual({ start: "06-17", end: "07-01" });
    expect(probableWindow(null, 2027)).toEqual({ start: "01-01", end: "12-31" });
    // A rule that wraps the year end keeps a wrapping window.
    expect(probableWindow({ type: "fixed", start: "12-28", end: "01-02" } as never, 2027)).toEqual({ start: "12-21", end: "01-09" });
    const unverified = mapFestival(with_({ rule_evidence: null, next_edition: null }), "PE", "America/Lima", ctx, TODAY) as MappedFestival;
    expect(unverified.festival.rule).toEqual({ type: "announced", window: { start: "06-17", end: "07-01" } });
    expect(unverified.porMedir).toContain("rule");
  });

  test("editions: only this year or next, start ≤ end, dates stated by the quote", () => {
    const edition = (over: object) => (mapFestival(with_({ next_edition: { ...inti.next_edition!, ...over } }), "PE", "America/Lima", ctx, TODAY) as MappedFestival).datedEdition;
    expect(edition({})).toBe(true);
    expect(edition({ year: 2030, start: "2030-06-24", end: "2030-06-24" })).toBe(false);
    expect(edition({ start: "2027-06-25" })).toBe(false);
    expect(edition({ start: "2027-06-24", end: "2027-06-23" })).toBe(false);
    expect(edition({ status: "por_anunciar" })).toBe(true);
  });

  test("R2/R11 flags: few sourced festivals, partial A coverage, media-heavy candidates, one city on top", () => {
    const m = (city: string, source: DraftFestival["candidate_source"], tier: "A" | "B" | "C" | null, dated: boolean): MappedFestival =>
      ({
        festival: { city, editions: dated ? { "2027": { sources: tier ? [{ tier }] : [] } } : {} },
        sources: tier ? [{ tier }] : [],
        candidateSource: source,
        datedEdition: dated,
      }) as unknown as MappedFestival;
    const list = [m("Lima", "prensa", "C", true), m("Lima", "prensa", "B", true), m("Lima", "otro", null, false)];
    const flags = onboardFlags(list, list);
    expect(flags).toMatchObject({ sourced: 1, shareA: 0, nonMediaShare: 0 });
    expect(flags.messages.join("\n")).toMatch(/R2: solo 1 fiesta[\s\S]*cobertura parcial: 0%[\s\S]*R11: solo 0%[\s\S]*R11: alerta: las 3 mejores están en Lima/);
    const good = [m("Lima", "unesco", "A", true), m("Cusco", "cultura_turismo", "A", true), m("Puno", "feriados", "A", true)];
    expect(onboardFlags(good, good).messages).toEqual([]);
  });
});

describe("onboarding archives what it cites (prd-F10, R13)", () => {
  test("a non-dry run asks the archiver for every edition source and stores the copies", async () => {
    const root = tempRepo({ countries: [] });
    const asked: string[] = [];
    const archiver = { capture: (url: string) => (asked.push(url), Promise.resolve(`https://web.archive.org/web/20261026000000/${url}`)) };
    const result = await runOnboard(opts(root), deps({ archiver }));
    expect(result.exitCode).toBe(0);
    const stored = CountryFile.parse(readJsonFile(join(root, "data", "countries", "pe.json")));
    const sources = stored.festivals.flatMap((f) => Object.values(f.editions).flatMap((e) => e.sources));
    expect(sources.length).toBeGreaterThan(0);
    expect(asked.length).toBe(new Set(sources.map((s) => s.url)).size);
    expect(sources.every((s) => s.archive_url === `https://web.archive.org/web/20261026000000/${s.url}`)).toBe(true);
  });

  test("a dry run archives nothing", async () => {
    const asked: string[] = [];
    const archiver = { capture: (url: string) => (asked.push(url), Promise.resolve(null)) };
    await runOnboard(opts(tempRepo({ countries: [] }), { dryRun: true }), deps({ archiver }));
    expect(asked).toEqual([]);
  });
});
