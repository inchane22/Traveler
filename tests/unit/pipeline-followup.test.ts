// Follow-up search (R2, R7): when the first pass, restricted to official sites, cites pages but does
// not state an edition's dates, a second open search asks for those dates only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { sourcedFestivals } from "../../scripts/build-data.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { loadDomainPolicy } from "../../scripts/lib/domains.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport, replayTransport, type CreateParams, type MessagesTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { buildQueue } from "../../scripts/lib/queue.ts";
import { missingDateFacts, runRefresh, searchedBlind, type RefreshDeps } from "../../scripts/lib/refresh-run.ts";
import type { FestivalLog } from "../../scripts/lib/report.ts";
import type { ReviewedChange } from "../../scripts/lib/validate.ts";
import { cite, config, country, json, message, REFRESH_FIXTURES, refreshOptions, REPO, search, tempRepo, text, TODAY, usage } from "../fixtures/pipeline/helpers.ts";

const deps = (transport: MessagesTransport, over: Partial<RefreshDeps> = {}): RefreshDeps => ({ transport, archiver: noopArchiver, usage: memoryUsageStore(), log: memoryLogger(), ...over });
const tool = (p: CreateParams) => (p.tools as Anthropic.WebSearchTool20260209[])[0]!;
const userText = (p: CreateParams) => String(p.messages[0]!.content);
const researchCalls = (t: { calls: Array<{ ctx: { kind: string }; params: CreateParams }> }) => t.calls.filter((c) => c.ctx.kind === "research");

const GOVBR = "https://www.gov.br/turismo/pt-br/assuntos/noticias/frevo-patrimonio";
const PREF = "https://www.recife.pe.gov.br/noticias/carnaval-do-recife-2027";
const QUOTE_PT = "O Carnaval do Recife 2027 será de 6 a 9 de fevereiro de 2027, com o Galo da Madrugada no sábado.";
const change = (field: string, value: string | number, urls: string[], quote: string, lang = "pt", confidence = "oficial") => ({ field, old: null, new: value, source_urls: urls, quote, quote_language: lang, confidence, note: "test" });

/** Pass 1 cites an official page that says nothing about the 2027 dates. */
const officialOnly = (query: string, url = GOVBR) =>
  message([...search(query, [url]), text("reconhecimento: ", [cite(url, "O frevo é Patrimônio Cultural Imaterial da Humanidade desde 2012.")]), text("start: no encontrado. end: no encontrado.")], "end_turn", usage(3000, 300, 1));
const nothingFound = (slug: string) => json({ country: "BR", slug, edition: 2027, changes: [], not_found: ["start", "end", "status"] });

describe("follow-up search for missing dates", () => {
  test("official pass without dates: the open pass asks only for them, and its validated dates are proposed", async () => {
    const transport = replayTransport({
      "BR/carnaval-recife": {
        research: [officialOnly("Carnaval do Recife 2027 datas"), message([...search("Carnaval Recife 2027 data oficial", [PREF]), text("start: 2027-02-06; end: 2027-02-09. ", [cite(PREF, QUOTE_PT)])], "end_turn", usage(4000, 300, 2))],
        extract: [
          nothingFound("carnaval-recife"),
          json({
            country: "BR",
            slug: "carnaval-recife",
            edition: 2027,
            changes: [change("start", "2027-02-06", [PREF], "de 6 a 9 de fevereiro de 2027"), change("end", "2027-02-09", [PREF], "de 6 a 9 de fevereiro de 2027"), change("score.convocatoria", 3_700_000, [PREF], "3,7 milhões")],
            not_found: [],
          }),
        ],
      },
    });
    const root = tempRepo({ countries: ["br"] });
    // The R2 section is about drafts: keep BR one here whatever its status in data/.
    const brPath = join(root, "data", "countries", "br.json");
    writeFileSync(brPath, `${JSON.stringify({ ...JSON.parse(readFileSync(brPath, "utf8")), status: "borrador" }, null, 2)}\n`);
    const result = await runRefresh(refreshOptions(root, { country: "BR", only: "carnaval-recife", maxFollowups: 2 }), deps(transport));
    const r = result.report!;

    expect(r.applied.map((c) => [c.field, c.new, c.confidence])).toEqual(expect.arrayContaining([["start", "2027-02-06", "oficial"], ["end", "2027-02-09", "oficial"]]));
    // The follow-up only fills the facts it was asked for.
    expect([...r.applied, ...r.flagged, ...r.rejected, ...r.confirmations].some((c) => c.field === "score.convocatoria")).toBe(false);
    expect(r.festivals[0]).toMatchObject({ outcome: "ok", pass: 1, followup: { fields: ["start", "end", "status"], outcome: "ok", citations: 1, answered: ["start", "end"] } });
    expect(r.not_found.find((n) => n.slug === "carnaval-recife")?.fields ?? []).not.toContain("start");

    const [first, second] = researchCalls(transport);
    expect(tool(first!.params).allowed_domains).toContain("gov.br");
    expect(tool(second!.params)).not.toHaveProperty("allowed_domains");
    expect(tool(second!.params).blocked_domains).toContain("viagogo.com");
    expect(userText(second!.params)).toContain("did not state these facts");
    expect(userText(second!.params)).toContain("- end: last day of the festival");
    expect(userText(second!.params)).not.toContain("attendance");
    expect(userText(first!.params)).toContain("attendance");

    // R2: Recife adds one dated, A-sourced festival to Brazil and the PR says how to publish it.
    const before = sourcedFestivals(country("BR"), loadDomainPolicy(REPO, "BR"));
    expect(before).toBeGreaterThanOrEqual(2);
    expect(r.drafts).toEqual([{ country: "BR", before, after: before + 1, needed: 3 }]);
    const md = readFileSync(join(root, "proposals", `${TODAY}.md`), "utf8");
    expect(md).toContain("### Países en borrador (R2)");
    expect(md).toContain("**Listo:** se publica solo al final de esta corrida.");
    expect(md).toContain("búsqueda amplia para inicio, fin, estado: ok, 1 citas, propuso inicio, fin");
  });

  test("the first pass wins: the follow-up keeps only the facts that were still missing", async () => {
    const pasto = "https://www.pasto.gov.co/index.php/noticias/carnaval-2027";
    const eltiempo = "https://www.eltiempo.com/colombia/otras-ciudades/carnaval-negros-y-blancos-2027";
    const espectador = "https://www.elespectador.com/colombia/carnaval-de-negros-y-blancos-2027";
    const press = "El Carnaval de Negros y Blancos 2027 será del 3 al 7 de enero de 2027.";
    const transport = replayTransport({
      "CO/negros-y-blancos": {
        research: [
          message([...search("Carnaval de Negros y Blancos 2027", [pasto]), text("start: 2027-01-02. ", [cite(pasto, "El carnaval de 2027 arranca el 2 de enero de 2027 con el Precarnaval.")])], "end_turn", usage(3000, 300, 1)),
          message([...search("Negros y Blancos 2027 fechas", [eltiempo, espectador]), text("start: 2027-01-03; end: 2027-01-07. ", [cite(eltiempo, press), cite(espectador, press)])], "end_turn", usage(4000, 300, 2)),
        ],
        extract: [
          json({ country: "CO", slug: "negros-y-blancos", edition: 2027, changes: [change("start", "2027-01-02", [pasto], "el 2 de enero de 2027", "es")], not_found: ["end", "status"] }),
          json({
            country: "CO",
            slug: "negros-y-blancos",
            edition: 2027,
            changes: [change("start", "2027-01-03", [eltiempo, espectador], "del 3 al 7 de enero de 2027", "es", "prensa"), change("end", "2027-01-07", [eltiempo, espectador], "del 3 al 7 de enero de 2027", "es", "prensa")],
            not_found: [],
          }),
        ],
      },
    });
    const r = (await runRefresh(refreshOptions(tempRepo(), { only: "negros-y-blancos", maxFollowups: 1 }), deps(transport))).report!;
    const all = [...r.applied, ...r.flagged, ...r.rejected];
    expect(all.filter((c) => c.field === "start").map((c) => c.new)).toEqual(["2027-01-02"]);
    // Tier 1: two press outlets on different domains are enough (R1/R2).
    expect(r.applied.find((c) => c.field === "end")).toMatchObject({ new: "2027-01-07", confidence: "prensa", verdict: "accepted" });
    expect(r.festivals[0]!.followup).toMatchObject({ fields: ["end", "status"], answered: ["end"] });
  });

  test("no follow-up when the first pass states the dates, when none are allowed, or in a news sweep", async () => {
    const recorded = fixtureDirTransport(REFRESH_FIXTURES);
    const stated = await runRefresh(refreshOptions(tempRepo(), { only: "negros-y-blancos", maxFollowups: 3 }), deps(recorded));
    expect(researchCalls(recorded)).toHaveLength(1);
    expect(stated.report!.festivals[0]!.followup).toBeUndefined();

    const noDates = () => replayTransport({ "BR/carnaval-recife": { research: [officialOnly("Carnaval do Recife 2027")], extract: [nothingFound("carnaval-recife")] } });
    const off = noDates();
    await runRefresh(refreshOptions(tempRepo({ countries: ["br"] }), { country: "BR", only: "carnaval-recife" }), deps(off));
    expect(researchCalls(off)).toHaveLength(1);
    const sweep = noDates();
    await runRefresh(refreshOptions(tempRepo({ countries: ["br"] }), { country: "BR", only: "carnaval-recife", today: "2027-01-10", sweepWithin: 45, maxFollowups: 3 }), deps(sweep));
    expect(researchCalls(sweep)).toHaveLength(1);

    // 120 days or more out (Recife on 2026-10-01 is 128): nobody has published the dates yet.
    const far = noDates();
    await runRefresh(refreshOptions(tempRepo({ countries: ["br"] }), { country: "BR", only: "carnaval-recife", today: "2026-10-01", maxFollowups: 3 }), deps(far));
    expect(researchCalls(far)).toHaveLength(1);
  });

  test("at most maxFollowups per run, in queue order; a failed follow-up keeps the first pass", async () => {
    const generic: MessagesTransport & { calls: Array<{ ctx: { key: string; kind: string }; params: CreateParams }> } = {
      calls: [],
      create(params, ctx) {
        this.calls.push({ ctx, params });
        const slug = ctx.key.split("/")[1]!;
        if (ctx.kind === "extract") return Promise.resolve(nothingFound(slug));
        // The second research call of the first festival fails: its first pass must survive.
        const research = this.calls.filter((c) => c.ctx.kind === "research" && c.ctx.key === ctx.key).length;
        if (research === 2) return Promise.reject(new Anthropic.APIError(529, undefined, "Overloaded", new Headers()));
        return Promise.resolve(officialOnly(slug));
      },
    };
    const queue = buildQueue([country("BR")], config, TODAY, { max: 40, perCountry: 10, country: "BR" }).map((i) => i.slug);
    const result = await runRefresh(refreshOptions(tempRepo({ countries: ["br"] }), { country: "BR", maxFollowups: 1 }), deps(generic));
    const logs = result.report!.festivals;
    expect(logs.map((l) => l.slug)).toEqual(queue);
    expect(logs.every((l) => l.outcome === "ok")).toBe(true);
    const followed = logs.filter((l) => l.followup);
    expect(followed).toHaveLength(1);
    expect(followed[0]!.slug).toBe(queue[0]);
    expect(researchCalls(generic)).toHaveLength(queue.length + 1);
    expect(result.exitCode).toBe(0);
  });
});

describe("missing date facts", () => {
  const item = (slug: string) => buildQueue([country("BR")], config, TODAY, { max: 40, perCountry: 10, only: slug })[0]!;
  const reviewed = (field: string, verdict: ReviewedChange["verdict"]) => ({ field, verdict }) as ReviewedChange;

  test("only editions without confirmed dates, and only the facts no valid proposal answered", () => {
    expect(missingDateFacts(item("carnaval-salvador"), [])).toEqual([]);
    expect(missingDateFacts(item("carnaval-recife"), [])).toEqual(["start", "end", "status"]);
    expect(missingDateFacts(item("carnaval-recife"), [reviewed("start", "accepted"), reviewed("end", "rejected")])).toEqual(["end", "status"]);
    expect(missingDateFacts(item("carnaval-recife"), [reviewed("start", "flagged"), reviewed("end", "accepted")])).toEqual([]);
    expect(missingDateFacts(item("festival-parintins"), [])).toEqual(["start", "end", "status"]);
  });

  test("a cancelled edition has no dates to look for: no follow-up is spent on it", () => {
    const recife = item("carnaval-recife");
    const source = { url: "https://www.recife.pe.gov.br/", publisher: "Prefeitura do Recife", accessed: TODAY, tier: "A" as const };
    const cancelled = { status: "cancelada" as const, confidence: "oficial" as const, key_events: [], sources: [source], sequence: 1 };
    const festival = { ...recife.festival, editions: { ...recife.festival.editions, [String(recife.year)]: cancelled } };
    expect(missingDateFacts({ ...recife, festival }, [])).toEqual([]);
  });
});

describe("blind search check", () => {
  const log = (outcome: FestivalLog["outcome"]) => ({ outcome }) as FestivalLog;

  test("a weekly run where every researched festival got no citation goes red; a sweep never does", async () => {
    expect(searchedBlind([log("no_citations"), log("no_citations"), log("skipped_budget")], undefined)).toBe(true);
    expect(searchedBlind([log("no_citations"), log("ok")], undefined)).toBe(false);
    expect(searchedBlind([log("no_citations")], undefined)).toBe(false);
    expect(searchedBlind([log("no_citations"), log("no_citations")], 45)).toBe(false);

    const uncited: MessagesTransport = { create: () => Promise.resolve(message([text("start: no encontrado.")], "end_turn", usage(2000, 50, 5))) };
    const lines = memoryLogger();
    const result = await runRefresh(refreshOptions(tempRepo({ countries: ["br"] }), { country: "BR" }), deps(uncited, { log: lines }));
    expect(result.report!.festivals.every((f) => f.outcome === "no_citations")).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(lines.lines.join("\n")).toMatch(/without a single citation/);
  });
});
