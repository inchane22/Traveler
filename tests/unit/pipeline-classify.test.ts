// The classifier (2026-11-09): the calendar lists parties, so an AI reads each festival's sources
// and decides whether it is one (`score.fiesta`) and where its crowd comes from (`score.viajeros`).
// A solemn act leaves every list; a first classification applies on its own, an override waits
// for a person.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, sourcedFestivals } from "../../scripts/build-data.ts";
import { refreshArgs, UsageError } from "../../scripts/lib/args.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { replayTransport, type CreateParams, type MessagesTransport } from "../../scripts/lib/client.ts";
import Anthropic from "@anthropic-ai/sdk";
import { memoryLogger } from "../../scripts/lib/io.ts";
import type { LedgerEntry } from "../../scripts/lib/ledger.ts";
import { CLASSIFY_RETRY_DAYS, makePlan, type PipelineSettings } from "../../scripts/lib/plan.ts";
import { buildClassifyQueue, needsClassifying } from "../../scripts/lib/queue.ts";
import { CLASSIFY_MAX_USES, missingClassifyFacts, runRefresh } from "../../scripts/lib/refresh-run.ts";
import { isUnsupportedCountry, researchPass, withoutCountry } from "../../scripts/lib/research.ts";
import { runPipeline } from "../../scripts/lib/pipeline-run.ts";
import { reviewChange, type ReviewContext, type ReviewedChange } from "../../scripts/lib/validate.ts";
import { buildEntries, ctxFor, isVisible } from "../../src/festivals.ts";
import { ChangelogEntry, CountryFile, type Festival, type ScoreInputs } from "../../src/schema.ts";
import { isParty, scoreFestival } from "../../src/score.ts";
import { cite, config, coPolicy, country, json, message, readJsonFile, REPO, search, tempRepo, text, TODAY, usage } from "../fixtures/pipeline/helpers.ts";

const SANPACHO = "https://www.quibdo-choco.gov.co/noticias/fiestas-de-san-pacho";
const SANPACHO_TEXT = "Durante quince días los barrios de Quibdó salen a la calle con sus comparsas y chirimías, y miles de visitantes de todo el país bailan con ellos.";

const unclassified = (s: ScoreInputs): ScoreInputs => ({ ...s, fiesta: null, viajeros: null });

/** A temp repo whose CO festival `slug` is not classified yet. */
function repoWithUnclassified(slug: string): string {
  const root = tempRepo({ countries: ["co"] });
  const path = join(root, "data", "countries", "co.json");
  const file = CountryFile.parse(readJsonFile(path));
  const next = { ...file, festivals: file.festivals.map((f) => (f.slug === slug ? { ...f, score: unclassified(f.score) } : f)) };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return root;
}

const coFile = (root: string) => CountryFile.parse(readJsonFile(join(root, "data", "countries", "co.json")));
const fest = (root: string, slug: string) => coFile(root).festivals.find((f) => f.slug === slug)!;

function proposal(changes: unknown[]) {
  return json({ country: "CO", slug: "san-pacho", edition: 2027, changes, not_found: [] });
}

const change = (field: string, old: string | null, value: string) => ({
  field,
  old,
  new: value,
  source_urls: [SANPACHO],
  quote: SANPACHO_TEXT,
  quote_language: "es",
  confidence: "oficial" as const,
  note: "Comparsas en la calle con visitantes de todo el país.",
});

describe("score: the calendar lists parties", () => {
  const base = country("CO").festivals.find((f) => f.slug === "carnaval-barranquilla")!.score;

  test("a solemn act is excluded and hidden, whatever its points", () => {
    const solemn: ScoreInputs = { ...base, fiesta: { measure: "solemne", confidence: "estimacion" } };
    expect(isParty(solemn)).toBe(false);
    expect(scoreFestival(solemn, config)).toMatchObject({ excluded: true, tier: "hidden" });
    expect(isParty(base)).toBe(true);
    expect(scoreFestival(base, config).excluded).toBe(false);
  });

  test("an unclassified festival is still listed, with its range", () => {
    const open = unclassified(base);
    expect(isParty(open)).toBe(true);
    const s = scoreFestival(open, config);
    expect(s.excluded).toBe(false);
    expect(s.high - s.low).toBe(config.criteria.fiesta.max + config.criteria.viajeros.max);
  });

  test("a solemn act leaves every view, the country's top 5 included, and R2 does not count it", () => {
    const co = country("CO");
    const target = co.festivals[0]!;
    const withSolemn = { ...co, festivals: co.festivals.map((f) => (f.slug === target.slug ? { ...f, score: { ...f.score, fiesta: { measure: "solemne" as const, confidence: "estimacion" as const } } } : f)) };
    const entries = buildEntries(withSolemn, config, TODAY);
    expect(entries.map((e) => e.festival.slug)).not.toContain(target.slug);
    expect(entries.filter((e) => isVisible(e, { kind: "country", code: "CO" }, true)).map((e) => e.festival.slug)).not.toContain(target.slug);
    expect(sourcedFestivals(withSolemn, coPolicy)).toBe(sourcedFestivals(co, coPolicy) - (sourcedFestivals({ ...co, festivals: [target] }, coPolicy)));
    const index = buildIndex([withSolemn], config, false);
    expect(index.slugs[target.slug]).toBeUndefined();
    expect(index.countries[0]!.festivals).toBe(co.festivals.length - 1);
    expect(index.tier1).not.toContain(`CO/${target.slug}`);
  });
});

describe("validate: fiesta and viajeros are the classifier's call", () => {
  const ctxFor0 = (festival: Festival): ReviewContext => ({
    country: "CO",
    festival,
    tier: 1,
    year: 2027,
    daysToStart: 200,
    citations: [cite(SANPACHO, SANPACHO_TEXT)],
    policy: coPolicy,
    ruleCtx: ctxFor(country("CO")),
  });
  const sanPacho = country("CO").festivals.find((f) => f.slug === "san-pacho")!;

  test("a first classification is accepted; levels outside the schema are rejected", () => {
    const open = { ...sanPacho, score: unclassified(sanPacho.score) };
    expect(reviewChange(change("score.fiesta", null, "baile_abierto"), ctxFor0(open))).toMatchObject({ verdict: "accepted", kind: "change", confidence: "oficial" });
    expect(reviewChange(change("score.viajeros", null, "nacional"), ctxFor0(open)).verdict).toBe("accepted");
    expect(reviewChange(change("score.fiesta", null, "solemne"), ctxFor0(open)).verdict).toBe("accepted");
    expect(reviewChange(change("score.fiesta", null, "rumba"), ctxFor0(open)).reasons.join()).toMatch(/valor inválido/);
  });

  test("taking a listed party off the site, or bringing a solemn act back, waits for a person", () => {
    const party = { ...sanPacho, score: { ...sanPacho.score, fiesta: { measure: "baile_abierto" as const, confidence: "oficial" as const, source: SANPACHO } } };
    expect(reviewChange(change("score.fiesta", "baile_abierto", "solemne"), ctxFor0(party)).flags.join()).toMatch(/deja de ser fiesta/);
    expect(reviewChange(change("score.fiesta", "baile_abierto", "baile_y_show"), ctxFor0(party)).verdict).toBe("accepted");
    const solemn = { ...sanPacho, score: { ...sanPacho.score, fiesta: { measure: "solemne" as const, confidence: "oficial" as const, source: SANPACHO } } };
    expect(reviewChange(change("score.fiesta", "solemne", "baile_abierto"), ctxFor0(solemn)).flags.join()).toMatch(/vuelve al sitio/);
  });

  test("calle and conectividad stay a person's call", () => {
    expect(reviewChange(change("score.calle", "mayoria_gratis", "mixta"), ctxFor0(sanPacho)).flags.join()).toMatch(/criterio de juicio/);
  });
});

describe("refresh --classify with recorded responses", () => {
  test("researches with the classifier prompts, applies the levels, rejects anything else, records job «classify»", async () => {
    const root = repoWithUnclassified("san-pacho");
    const logBefore = ChangelogEntry.array().parse(readJsonFile(join(root, "data", "changelog.json"))).length;
    const transport = replayTransport({
      "CO/san-pacho": {
        research: [message([...search("fiestas de san pacho quibdó", [SANPACHO]), text("fiesta: baile_abierto. viajeros: nacional.", [cite(SANPACHO, SANPACHO_TEXT)])], "end_turn", usage(4000, 300, 2))],
        extract: [proposal([change("score.fiesta", null, "baile_abierto"), change("score.viajeros", null, "nacional"), { ...change("start", null, "2027-09-20") }])],
      },
    });
    const usageStore = memoryUsageStore();
    const result = await runRefresh(
      { root, dryRun: false, today: TODAY, model: "claude-sonnet-5-5", classify: true, maxFestivals: 40, perCountry: 10, budgetUsd: 20 },
      { transport, archiver: noopArchiver, usage: usageStore, log: memoryLogger() },
    );
    expect(result.exitCode).toBe(0);
    const r = result.report!;
    expect(r.classify).toBe(true);
    expect(r.festivals.map((f) => f.slug)).toEqual(["san-pacho"]);

    const researchCall = transport.calls.find((c) => c.ctx.kind === "research")!;
    const system = JSON.stringify(researchCall.params.system);
    expect(system).toContain("solemn act");
    expect(system).toContain(config.criteria.fiesta.rule!.slice(0, 40));
    expect(JSON.stringify(researchCall.params.messages)).toContain("baile_abierto, baile_y_show, show or solemne");
    expect((researchCall.params.tools![0] as { max_uses: number }).max_uses).toBe(CLASSIFY_MAX_USES);
    expect(JSON.stringify(transport.calls.find((c) => c.ctx.kind === "extract")!.params.system)).toContain("`score.fiesta` or `score.viajeros`");

    expect(r.applied.map((c) => [c.field, c.new])).toEqual(expect.arrayContaining([["score.fiesta", "baile_abierto"], ["score.viajeros", "nacional"]]));
    expect(r.rejected.find((c) => c.field === "start")!.reasons.join()).toMatch(/fuera de lo que se pidió/);

    const stored = fest(root, "san-pacho");
    expect(stored.score.fiesta).toMatchObject({ measure: "baile_abierto", confidence: "oficial", source: SANPACHO, quote: SANPACHO_TEXT });
    expect(stored.score.viajeros).toMatchObject({ measure: "nacional" });
    expect(Object.values(stored.editions).every((e) => e.start !== "2027-09-20")).toBe(true);
    const log = ChangelogEntry.array().parse(readJsonFile(join(root, "data", "changelog.json")));
    expect(log.slice(logBefore).map((e) => [e.slug, e.field]).sort()).toEqual([["san-pacho", "score.fiesta"], ["san-pacho", "score.viajeros"]]);
    expect(new Set(usageStore.entries.map((e) => e.job))).toEqual(new Set(["classify"]));
    expect(readFileSync(join(root, "proposals", `${TODAY}.md`), "utf8")).toContain(`## Clasificación ${TODAY}`);
  });

  test("a festival classified as a solemn act leaves the lists after the run", async () => {
    const root = repoWithUnclassified("san-pacho");
    const transport = replayTransport({
      "CO/san-pacho": {
        research: [message([...search("q", [SANPACHO]), text("fiesta: solemne.", [cite(SANPACHO, SANPACHO_TEXT)])], "end_turn", usage(4000, 300, 1))],
        extract: [proposal([change("score.fiesta", null, "solemne")])],
      },
    });
    await runRefresh(
      { root, dryRun: false, today: TODAY, model: "claude-sonnet-5-5", classify: true, maxFestivals: 40, perCountry: 10, budgetUsd: 20 },
      { transport, archiver: noopArchiver, usage: memoryUsageStore(), log: memoryLogger() },
    );
    expect(buildEntries(coFile(root), config, TODAY).map((e) => e.festival.slug)).not.toContain("san-pacho");
  });

  test("the queue holds unclassified festivals only, unless --only asks for one", () => {
    const root = repoWithUnclassified("san-pacho");
    const all = [coFile(root)];
    expect(buildClassifyQueue(all, config, TODAY, { max: 40 }).map((i) => [i.slug, i.reasons])).toEqual([["san-pacho", ["unclassified"]]]);
    expect(buildClassifyQueue(all, config, TODAY, { max: 40, only: "carnaval-barranquilla" }).map((i) => [i.slug, i.reasons])).toEqual([["carnaval-barranquilla", ["manual"]]]);
    expect(needsClassifying(fest(root, "carnaval-barranquilla"))).toBe(false);
  });

  test("CLI flag", () => {
    expect(refreshArgs(["--classify"], {}).classify).toBe(true);
    expect(refreshArgs([], {}).classify).toBe(false);
    expect(() => refreshArgs(["--classify", "--sweep=news"], {})).toThrow(UsageError);
    expect(() => refreshArgs(["--classify=yes"], {})).toThrow(UsageError);
  });
});

describe("plan: unclassified festivals of live countries are classified first", () => {
  const settings = readJsonFile<PipelineSettings>(join(REPO, "config", "pipeline.json"));
  const plan = (countries: CountryFile[], ledger: LedgerEntry[] = []) =>
    makePlan({ today: "2026-11-09", budgetUsd: 20, settings, countries, config, requests: [], ledger, configured: new Set(["CO"]), maxFestivals: 40 });

  test("the classify band comes right after the last-week sweeps", () => {
    const root = repoWithUnclassified("san-pacho");
    const p = plan([coFile(root)]);
    expect(p.classify.map((i) => i.slug)).toEqual(["san-pacho"]);
    expect(plan([country("CO")]).classify).toEqual([]);
  });

  test(`a classification that found nothing is not repeated for ${CLASSIFY_RETRY_DAYS} days`, () => {
    const root = repoWithUnclassified("san-pacho");
    const tried = (day: string): LedgerEntry => ({ day, job: "classify", key: "CO/san-pacho", call: "research", model: "m", searches: 1, input_tokens: 1, output_tokens: 1, usd: 0.1 });
    expect(plan([coFile(root)], [tried("2026-11-01")]).classify).toEqual([]);
    expect(plan([coFile(root)], [tried("2026-10-01")]).classify.map((i) => i.slug)).toEqual(["san-pacho"]);
  });
});

describe("where the crowd comes from is rarely on an official site", () => {
  const PRESS = "https://www.eltiempo.com/colombia/san-pacho-turistas";
  const PRESS_TEXT = "Las Fiestas de San Pacho recibieron este año turistas de todo el país y de Estados Unidos y España.";

  test("missing facts are the ones no valid change answered", () => {
    const c = (field: string, verdict: ReviewedChange["verdict"]) => ({ field, verdict }) as ReviewedChange;
    expect(missingClassifyFacts([])).toEqual(["score.fiesta", "score.viajeros"]);
    expect(missingClassifyFacts([c("score.fiesta", "accepted"), c("score.viajeros", "rejected")])).toEqual(["score.viajeros"]);
    expect(missingClassifyFacts([c("score.fiesta", "flagged"), c("score.viajeros", "accepted")])).toEqual([]);
  });

  test("a first pass on official sites that leaves viajeros out gets one wider search for it, on the classify ledger", async () => {
    const root = repoWithUnclassified("san-pacho");
    const transport = replayTransport({
      "CO/san-pacho": {
        research: [
          message([...search("q", [SANPACHO]), text("fiesta: baile_abierto. viajeros: no encontrado.", [cite(SANPACHO, SANPACHO_TEXT)])], "end_turn", usage(4000, 300, 1)),
          message([...search("q", [PRESS]), text("viajeros: internacional.", [cite(PRESS, PRESS_TEXT)])], "end_turn", usage(4000, 300, 2)),
        ],
        extract: [
          proposal([change("score.fiesta", null, "baile_abierto")]),
          proposal([{ ...change("score.viajeros", null, "internacional"), source_urls: [PRESS], quote: PRESS_TEXT, confidence: "prensa" }, change("score.fiesta", null, "show")]),
        ],
      },
    });
    const usageStore = memoryUsageStore();
    const r = (await runRefresh(
      { root, dryRun: false, today: TODAY, model: "claude-sonnet-5-5", classify: true, maxFestivals: 40, perCountry: 10, budgetUsd: 20 },
      { transport, archiver: noopArchiver, usage: usageStore, log: memoryLogger() },
    )).report!;
    const research = transport.calls.filter((c) => c.ctx.kind === "research");
    expect(research).toHaveLength(2);
    // Pass 2 drops the allow-list and asks only for the missing fact.
    expect(JSON.stringify(research[1]!.params.tools)).not.toContain("allowed_domains");
    const asked = JSON.stringify(research[1]!.params.messages);
    expect(asked).toContain("did not show these facts");
    expect(asked).toContain("- viajeros:");
    expect(asked).not.toContain("- fiesta:");
    expect(r.festivals[0]!.followup).toMatchObject({ fields: ["score.viajeros"], outcome: "ok", answered: ["score.viajeros"] });
    // The first pass wins on what it answered: the follow-up's «show» is not kept.
    expect(fest(root, "san-pacho").score).toMatchObject({ fiesta: { measure: "baile_abierto" }, viajeros: { measure: "internacional", source: PRESS } });
    expect(new Set(usageStore.entries.map((e) => e.job))).toEqual(new Set(["classify"]));
  });
});

describe("the search tool refuses a location hint for some countries (2026-11-09: CO, PE, BO)", () => {
  const refused = () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "tools.0.web_search_20260209: Country code CO is not supported." } }, "400 tools.0.web_search_20260209: Country code CO is not supported.", new Headers());

  test("only that 400 counts; other errors are not retried", () => {
    expect(isUnsupportedCountry(refused())).toBe(true);
    expect(isUnsupportedCountry(new Anthropic.BadRequestError(400, undefined, "max_tokens too large", new Headers()))).toBe(false);
    expect(isUnsupportedCountry(new Anthropic.RateLimitError(429, undefined, "Country code CO is not supported", new Headers()))).toBe(false);
  });

  test("the call is made again without the country, keeping the time zone", async () => {
    const sent: CreateParams[] = [];
    const transport: MessagesTransport = {
      create(params) {
        sent.push(structuredClone(params));
        if (sent.length === 1) return Promise.reject(refused());
        return Promise.resolve(message([...search("q", [SANPACHO]), text("fiesta: baile_abierto.", [cite(SANPACHO, SANPACHO_TEXT)])]));
      },
    };
    const result = await researchPass(transport, { beforeCall: () => {}, afterCall: () => {} }, { key: "CO/san-pacho", model: "m", system: "s", user: "u", country: "CO", timezone: "America/Bogota", maxUses: 3, allowedDomains: ["gov.co"], blockedDomains: [] }, 1);
    expect(result.outcome).toBe("ok");
    const location = (p: CreateParams) => (p.tools![0] as unknown as { user_location: Record<string, string> }).user_location;
    expect(location(sent[0]!)).toMatchObject({ country: "CO", timezone: "America/Bogota" });
    expect(location(sent[1]!)).toEqual({ type: "approximate", timezone: "America/Bogota" });
    expect(withoutCountry(sent[1]!)).toEqual(sent[1]);
  });

  test("a refusal on the retry is not swallowed", async () => {
    const transport: MessagesTransport = { create: () => Promise.reject(refused()) };
    await expect(researchPass(transport, { beforeCall: () => {}, afterCall: () => {} }, { key: "k", model: "m", system: "s", user: "u", country: "CO", timezone: null, maxUses: 3, allowedDomains: [], blockedDomains: [] }, 2)).rejects.toThrow(/Country code CO/);
  });
});

describe("pipeline: the daily run classifies before it verifies", () => {
  test("an unclassified festival of a live country is classified; one found solemn is not verified the same day", async () => {
    const root = repoWithUnclassified("san-pacho");
    const transport = replayTransport({
      "CO/san-pacho": {
        research: [message([...search("q", [SANPACHO]), text("fiesta: solemne. viajeros: nacional.", [cite(SANPACHO, SANPACHO_TEXT)])], "end_turn", usage(4000, 300, 1))],
        extract: [proposal([change("score.fiesta", null, "solemne"), change("score.viajeros", null, "nacional")])],
      },
    });
    const store = memoryUsageStore();
    const result = await runPipeline(
      // June 2027: San Pacho (September) is inside 120 days and due for a verification as well.
      { root, today: "2027-06-01", model: "claude-sonnet-5-5", budgetUsd: 200, maxFestivals: 40, maxFollowups: 0, planOnly: false },
      { transport, archiver: noopArchiver, usage: store, ledger: () => store.entries, log: memoryLogger() },
    );
    expect(result.plan.classify.map((i) => i.slug)).toEqual(["san-pacho"]);
    // It was due for a verification too, which the classification called off.
    expect(result.plan.verify.map((i) => i.slug)).toContain("san-pacho");
    expect(transport.calls.filter((c) => c.ctx.key === "CO/san-pacho" && c.ctx.kind === "research")).toHaveLength(1);
    expect(fest(root, "san-pacho").score.fiesta).toMatchObject({ measure: "solemne" });
    const sanPachoJobs = store.entries.filter((e) => e.key === "CO/san-pacho").map((e) => e.job);
    expect(new Set(sanPachoJobs)).toEqual(new Set(["classify"]));
    expect(readFileSync(join(root, "proposals", "pipeline-2027-06-01.md"), "utf8")).toMatch(/Planned: \d+ news sweep\(s\), 1 classification\(s\)/);
  });
});
