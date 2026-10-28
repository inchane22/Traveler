// R6 (weekly broken-link check) and R13 (sources with neither original nor archive copy).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChangelogEntry, CountryFile } from "../../src/schema.ts";
import { main as checkLinksMain } from "../../scripts/check-links.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger, readJson } from "../../scripts/lib/io.ts";
import {
  applyLostSources,
  buildLinksReport,
  checkLink,
  checkLinks,
  dataLinks,
  editionDowngrade,
  isBotChallenge,
  isLost,
  LinksReport,
  lowerConfidence,
  readLinksReport,
  renderLinksMarkdown,
  urlsInJson,
  verdictForStatus,
  type LinkFetch,
  type LinkResponse,
  type LinkVerdict,
} from "../../scripts/lib/links.ts";
import { runRefresh } from "../../scripts/lib/refresh-run.ts";
import { readJsonFile, REFRESH_FIXTURES, refreshOptions, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";
import { edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";

interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

const response = (r: Reply): LinkResponse => ({
  status: r.status,
  headers: { get: (name) => r.headers?.[name.toLowerCase()] ?? null },
  text: () => Promise.resolve(r.body ?? ""),
});

/** Fake network: per URL, what HEAD and GET answer (an Error rejects); unknown URLs answer 200. */
function fakeFetch(table: Record<string, { HEAD?: Reply | Error; GET?: Reply | Error }>): LinkFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn: LinkFetch = (url, init) => {
    calls.push(`${init.method} ${url}`);
    const r = table[url]?.[init.method] ?? { status: 200 };
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(response(r));
  };
  return Object.assign(fn, { calls });
}

const CHALLENGE = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>";
const io = { read: readJson, exists: existsSync };

describe("link verdicts (R6)", () => {
  test("2xx/3xx ok, 404/410 broken, the rest cannot tell", () => {
    expect([200, 204, 301, 308].map(verdictForStatus)).toEqual(["ok", "ok", "ok", "ok"]);
    expect([404, 410].map(verdictForStatus)).toEqual(["broken", "broken"]);
    expect([400, 401, 403, 405, 418, 429, 500, 503].map(verdictForStatus).every((v) => v === "unknown")).toBe(true);
  });

  test("bot challenges are spotted by header or challenge-only markers, not by Cloudflare's normal script", () => {
    const none = response({ status: 200 }).headers;
    expect(isBotChallenge(response({ status: 403, headers: { "cf-mitigated": "challenge" } }).headers, "")).toBe(true);
    expect(isBotChallenge(none, CHALLENGE)).toBe(true);
    expect(isBotChallenge(none, '<html><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>Carnaval</html>')).toBe(false);
  });

  test("HEAD first, GET to confirm; challenges, rate limits and network errors are unknown, never broken", async () => {
    const f = fakeFetch({
      "https://a.example/ok": { HEAD: { status: 200 } },
      "https://a.example/head-405": { HEAD: { status: 405 }, GET: { status: 200 } },
      "https://a.example/gone": { HEAD: { status: 404 }, GET: { status: 404 } },
      "https://a.example/head-lies": { HEAD: { status: 404 }, GET: { status: 200 } },
      "https://a.example/410": { HEAD: { status: 410 }, GET: { status: 410 } },
      "https://travel.state.gov/x": { HEAD: { status: 403 }, GET: { status: 403, body: CHALLENGE, headers: { "cf-mitigated": "challenge" } } },
      "https://a.example/403": { HEAD: { status: 403 }, GET: { status: 403 } },
      "https://a.example/429": { HEAD: { status: 429 }, GET: { status: 429 } },
      "https://a.example/503": { HEAD: { status: 503 }, GET: { status: 503 } },
      "https://a.example/teapot": { HEAD: { status: 418 }, GET: { status: 418 } },
      "https://a.example/challenge-200": { HEAD: new Error("socket hang up"), GET: { status: 200, body: CHALLENGE } },
      "https://a.example/down": { HEAD: new Error("getaddrinfo ENOTFOUND"), GET: new Error("getaddrinfo ENOTFOUND") },
    });
    const verdict = async (url: string): Promise<LinkVerdict> => (await checkLink(url, f)).verdict;
    expect(await checkLink("https://a.example/ok", f)).toMatchObject({ verdict: "ok", method: "HEAD", status: 200 });
    expect(await verdict("https://a.example/head-405")).toBe("ok");
    expect(await checkLink("https://a.example/gone", f)).toMatchObject({ verdict: "broken", method: "GET", status: 404 });
    expect(await verdict("https://a.example/head-lies")).toBe("ok");
    expect(await verdict("https://a.example/410")).toBe("broken");
    expect(await checkLink("https://travel.state.gov/x", f)).toMatchObject({ verdict: "unknown", detail: expect.stringContaining("bot challenge") as unknown });
    for (const url of ["403", "429", "503", "teapot", "challenge-200"]) expect(await verdict(`https://a.example/${url}`)).toBe("unknown");
    expect(await checkLink("https://a.example/down", f)).toMatchObject({ verdict: "unknown", status: null, detail: expect.stringContaining("ENOTFOUND") as unknown });
    expect(f.calls.filter((c) => c === "GET https://a.example/ok")).toEqual([]);
  });

  test("each URL is checked once, with every place it appears; broken ones come first", async () => {
    const f = fakeFetch({ "https://b.example/dead": { HEAD: { status: 404 }, GET: { status: 404 } } });
    const results = await checkLinks(
      [
        { url: "https://b.example/live", where: "one" },
        { url: "https://b.example/dead", where: "two" },
        { url: "https://b.example/live", where: "three" },
      ],
      f,
      { concurrency: 2 },
    );
    expect(results.map((r) => [r.url, r.verdict, r.where])).toEqual([
      ["https://b.example/dead", "broken", ["two"]],
      ["https://b.example/live", "ok", ["one", "three"]],
    ]);
    expect(f.calls.filter((c) => c.startsWith("HEAD"))).toHaveLength(2);
  });
});

describe("what gets checked", () => {
  test("advisories: whole https values with their path; URLs inside notes are prose and skipped", () => {
    const refs = urlsInJson(
      { origins: { GB: { destinations: { CO: "https://www.gov.uk/foreign-travel-advice/colombia" }, fallback: null } }, unverified: [{ url: "https://travel.state.gov/x", note: "see https://other.example/y" }] },
      "config/advisories.json",
    );
    expect(refs).toEqual([
      { url: "https://www.gov.uk/foreign-travel-advice/colombia", where: "config/advisories.json origins.GB.destinations.CO" },
      { url: "https://travel.state.gov/x", where: "config/advisories.json unverified.0.url" },
    ]);
  });

  test("data: edition sources and their archive copies, score sources and rule tables", () => {
    const f = fest("AA", "fest", { type: "fixed", start: "03-01", end: "03-05" }, {
      "2027": edition({ sources: [source("https://org.example/a", { archive_url: "https://web.archive.org/web/20260101000000/https://org.example/a" })] }),
    });
    const scored = { ...f, score: { ...f.score, calle: { measure: "mixta" as const, confidence: "prensa" as const, source: "https://press.example/b" } } };
    expect(dataLinks([nation("AA", [scored])]).map((r) => r.where)).toEqual(["AA/fest 2027 sources[0]", "AA/fest 2027 sources[0] archive", "AA/fest score.calle"]);
  });
});

describe("check-links CLI", () => {
  test("writes proposals/links-<date>.md and .json; exit 1 only when a link is broken", async () => {
    const root = tempRepo({ countries: ["co"] });
    const advisories = readJsonFile<unknown>(join(root, "config", "advisories.json"));
    const firstAdvisory = urlsInJson(advisories, "a")[0]!.url;
    const broken = fakeFetch({ [firstAdvisory]: { HEAD: { status: 404 }, GET: { status: 404 } } });
    const log = memoryLogger();
    expect(await checkLinksMain([`--today=${TODAY}`], root, log, broken)).toBe(1);
    const report = LinksReport.parse(readJsonFile(join(root, "proposals", `links-${TODAY}.json`)));
    expect(report).toMatchObject({ kind: "links", date: TODAY, broken: 1 });
    expect(report.checked).toBe(new Set(report.results.map((r) => r.url)).size);
    const md = readFileSync(join(root, "proposals", `links-${TODAY}.md`), "utf8");
    expect(md).toContain("### Rotos (1)");
    expect(md).not.toMatch(/\u2014/);
    expect(log.lines.some((l) => l.startsWith("error: broken (404)"))).toBe(true);

    const challenged = fakeFetch({ [firstAdvisory]: { HEAD: { status: 403 }, GET: { status: 403, body: CHALLENGE } } });
    expect(await checkLinksMain([`--today=${TODAY}`], root, memoryLogger(), challenged)).toBe(0);
    expect(await checkLinksMain(["--today=26/10/2026"], root, memoryLogger(), challenged)).toBe(2);
    expect(await checkLinksMain(["--dry-run"], root, memoryLogger(), challenged)).toBe(2);
  });

  test("the Markdown report escapes what it prints", () => {
    const md = renderLinksMarkdown(buildLinksReport(TODAY, [{ url: "https://x.example/a", verdict: "broken", status: 404, method: "GET", detail: "<script>@all", where: ["AA/fest **bold**"] }]));
    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/(^|[^\\])@all/);
    expect(md).toContain("AA/fest \\*\\*bold\\*\\*");
  });
});

describe("R13: a source with neither original nor archive copy lowers confidence one level", () => {
  const DEAD = "https://org.example/dead";
  const DEAD2 = "https://press.example/dead";
  const LIVE = "https://org.example/live";
  const ARCHIVE = "https://web.archive.org/web/20260101000000/https://org.example/dead";
  const verdicts = new Map<string, LinkVerdict>([[DEAD, "broken"], [DEAD2, "broken"], [LIVE, "ok"], ["https://org.example/maybe", "unknown"]]);

  test("lost means broken original and no archive, or a broken archive; unknown never counts", () => {
    expect(isLost(source(DEAD), verdicts)).toBe(true);
    expect(isLost(source(DEAD, { archive_url: ARCHIVE }), verdicts)).toBe(false);
    expect(isLost(source(DEAD, { archive_url: ARCHIVE }), new Map([...verdicts, [ARCHIVE, "broken"]]))).toBe(true);
    expect(isLost(source("https://org.example/maybe"), verdicts)).toBe(false);
    expect(isLost(source("https://never.checked/x"), verdicts)).toBe(false);
    expect(["oficial", "prensa", "patron", "estimacion"].map((c) => lowerConfidence(c as never))).toEqual(["prensa", "patron", "estimacion", "estimacion"]);
  });

  test("an edition drops one level only when all its sources are lost, once", () => {
    const allDead = edition({ confidence: "oficial", sources: [source(DEAD), source(DEAD2)] });
    expect(editionDowngrade(allDead, verdicts, [])).toEqual({ confidence: "prensa", urls: [DEAD, DEAD2] });
    expect(editionDowngrade(edition({ confidence: "oficial", sources: [source(DEAD), source(LIVE)] }), verdicts, [])).toBeNull();
    expect(editionDowngrade(edition({ confidence: "estimacion", sources: [source(DEAD)] }), verdicts, [])).toBeNull();
    expect(editionDowngrade(edition({ confidence: "prensa", sources: [] }), verdicts, [])).toBeNull();
    const done = ChangelogEntry.parse({ date: "2026-10-19", country: "AA", slug: "fest", field: "confidence", old: "oficial", new: "prensa", source_urls: [DEAD2, DEAD] });
    expect(editionDowngrade({ ...allDead, confidence: "prensa" }, verdicts, [done])).toBeNull();
  });

  test("applyLostSources: no last_verified or SEQUENCE change, a changelog entry per downgrade, same object when nothing is lost", () => {
    const e = edition({ confidence: "oficial", status: "confirmada", start: "2027-03-01", end: "2027-03-05", sequence: 3, last_verified: "2026-09-01", sources: [source(DEAD)] });
    const aa = nation("AA", [fest("AA", "fest", { type: "fixed", start: "03-01", end: "03-05" }, { "2027": e })]);
    const r = applyLostSources(aa, verdicts, [], TODAY);
    expect(r.country.festivals[0]!.editions["2027"]).toEqual({ ...e, confidence: "prensa" });
    expect(CountryFile.safeParse(r.country).success).toBe(true);
    expect(r.entries).toEqual([{ date: TODAY, country: "AA", slug: "fest", field: "confidence", old: "oficial", new: "prensa", source_urls: [DEAD] }]);
    expect(r.downgrades).toEqual([{ country: "AA", slug: "fest", year: 2027, old: "oficial", new: "prensa", urls: [DEAD] }]);
    expect(applyLostSources(r.country, verdicts, r.entries, TODAY).country).toBe(r.country);
    expect(applyLostSources(aa, new Map(), [], TODAY).country).toBe(aa);
  });

  test("LINKS_REPORT_PATH: unset, missing, stale or invalid reports mean no R13 this run", () => {
    const root = tempRepo({ countries: [] });
    const log = memoryLogger();
    const write = (name: string, value: unknown) => {
      writeFileSync(join(root, name), JSON.stringify(value));
      return join(root, name);
    };
    const fresh = buildLinksReport("2026-10-25", [{ url: DEAD, verdict: "broken", status: 404, method: "GET", detail: "", where: ["x"] }]);
    expect(readLinksReport(undefined, TODAY, io, log)).toBeNull();
    expect(readLinksReport(join(root, "nope.json"), TODAY, io, log)).toBeNull();
    expect(readLinksReport(write("old.json", { ...fresh, date: "2026-10-01" }), TODAY, io, log)).toBeNull();
    expect(readLinksReport(write("future.json", { ...fresh, date: "2026-10-30" }), TODAY, io, log)).toBeNull();
    expect(readLinksReport(write("bad.json", { kind: "refresh" }), TODAY, io, log)).toBeNull();
    expect(readLinksReport(write("ok.json", fresh), TODAY, io, log)?.get(DEAD)).toBe("broken");
    expect(log.lines.filter((l) => l.startsWith("warning: R13")).length).toBe(4);
  });

  test("refresh applies it: the edition is written one level down with a changelog entry, and the next run does nothing", async () => {
    const root = tempRepo({ countries: ["co"] });
    const coPath = join(root, "data", "countries", "co.json");
    const co = CountryFile.parse(readJsonFile(coPath));
    const target = co.festivals.flatMap((f) => Object.entries(f.editions).map(([year, e]) => ({ slug: f.slug, year, e }))).find((x) => x.e.sources.length && x.e.confidence !== "estimacion");
    if (!target) throw new Error("CO has no edition with sources to test R13 on");
    const links = new Map<string, LinkVerdict>(target.e.sources.flatMap((s) => [[s.url, "broken" as const], ...(s.archive_url ? [[s.archive_url, "broken" as const] as const] : [])]));
    const deps = () => ({ transport: fixtureDirTransport(REFRESH_FIXTURES), archiver: noopArchiver, usage: memoryUsageStore(), log: memoryLogger() });
    // --only on a recorded refusal: no AI change, so everything written comes from R13.
    const opts = refreshOptions(root, { dryRun: false, only: "carnaval-riosucio", links });

    const dry = await runRefresh({ ...opts, dryRun: true }, deps());
    expect(dry.report!.link_downgrades!.some((d) => d.slug === target.slug)).toBe(true);
    expect(CountryFile.parse(readJsonFile(coPath))).toEqual(co);

    const run = await runRefresh(opts, deps());
    expect(run.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["data/changelog.json", "data/countries/co.json", "proposals/2026-10-26.json", "proposals/2026-10-26.md"]);
    const after = CountryFile.parse(readJsonFile(coPath)).festivals.find((f) => f.slug === target.slug)!.editions[target.year]!;
    expect(after).toEqual({ ...target.e, confidence: lowerConfidence(target.e.confidence) });
    const changelog = ChangelogEntry.array().parse(readJsonFile(join(root, "data", "changelog.json")));
    expect(changelog.at(-1)).toMatchObject({ date: TODAY, slug: target.slug, field: "confidence", old: target.e.confidence });
    expect(readFileSync(join(root, "proposals", `${TODAY}.md`), "utf8")).toContain("Fuentes perdidas, confianza un nivel abajo (R13)");

    const again = await runRefresh(opts, deps());
    expect(again.report!.link_downgrades ?? []).toEqual([]);
    expect(CountryFile.parse(readJsonFile(coPath)).festivals.find((f) => f.slug === target.slug)!.editions[target.year]).toEqual(after);
  });
});
