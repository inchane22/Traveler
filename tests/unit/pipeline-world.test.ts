// The build-on-request pipeline's pure parts: the planner, the request lifecycle, holds, the R2
// publish gate, the auto-approval safeguards, the source policy, country facts for any country,
// dates in any language and the intake of a request.
import { describe, expect, test } from "vitest";
import { ISO_COUNTRIES } from "../../src/search.ts";
import { pipelineArgs, UsageError } from "../../scripts/lib/args.ts";
import { holdRisky, independentSources, needsTwoSources } from "../../scripts/lib/autoapprove.ts";
import { replayTransport } from "../../scripts/lib/client.ts";
import { hasDateReader, quoteStatesDate } from "../../scripts/lib/date-parser.ts";
import { defaultGovernmentDomains, loadDomainPolicy, registrableDomain } from "../../scripts/lib/domains.ts";
import { holdFor, mergeHolds, renderHolds } from "../../scripts/lib/holds.ts";
import { memoryLogger, readJson } from "../../scripts/lib/io.ts";
import { countryInfo, deriveCountry, localLangFor, newsTerms, quoteSupportsStatus } from "../../scripts/lib/lang.ts";
import type { LedgerEntry } from "../../scripts/lib/ledger.ts";
import { intakeProblem, topUpQueue } from "../../scripts/lib/pipeline-run.ts";
import { budgetFor, buildEstimate, dueToday, jobCosts, makePlan, MAX_STRETCH, projection, sweepInterval, verifyInterval, type PipelineSettings, type PlanInput } from "../../scripts/lib/plan.ts";
import { promoteReady, readiness } from "../../scripts/lib/publish.ts";
import { countryFromIssue, nextRequest, requestsDue, type CountryRequest } from "../../scripts/lib/requests.ts";
import { cleanHost, draftSourcePolicy, policyFiles } from "../../scripts/lib/source-policy.ts";
import { config, country, json, readJsonFile, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";
import { accepted, cited, edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";
import { join } from "node:path";

const settings = readJson(join(REPO, "config", "pipeline.json")) as PipelineSettings;
const rules = { maxAttempts: settings.max_build_attempts, retryDays: settings.retry_days };
const line = (over: Partial<LedgerEntry>): LedgerEntry => ({ day: "2026-11-02", job: "verify", key: "AA/x", call: "research", model: "m", searches: 0, input_tokens: 0, output_tokens: 0, usd: 0.1, ...over });

describe("cadence: closer and unsettled is checked more; money short stretches only the far ones", () => {
  test("verification intervals by closeness, settlement and tier", () => {
    expect([verifyInterval(10, false), verifyInterval(60, false), verifyInterval(150, false), verifyInterval(300, false)]).toEqual([7, 14, 30, 60]);
    expect([verifyInterval(60, true), verifyInterval(200, true)]).toEqual([30, 90]);
    // Tier 2 is checked half as often beyond 45 days, never inside them.
    expect([verifyInterval(60, false, 2), verifyInterval(30, false, 2)]).toEqual([28, 7]);
    // A stretch lengthens what is beyond 45 days, capped at MAX_STRETCH; the last 45 days never stretch.
    expect([verifyInterval(60, false, 1, 2), verifyInterval(60, false, 1, 99), verifyInterval(30, false, 1, 4)]).toEqual([28, 14 * MAX_STRETCH, 7]);
  });

  test("news sweeps only in the last 45 days: weekly, then daily for tier 1 (every other day below) in the last week", () => {
    expect([sweepInterval(60), sweepInterval(30), sweepInterval(5), sweepInterval(5, 2), sweepInterval(-1), sweepInterval(Number.POSITIVE_INFINITY)]).toEqual([null, 7, 1, 2, 1, null]);
  });
});

describe("budget pools (R10)", () => {
  test("20% for new countries, 15% for new festivals, 65% for upkeep spread over the days left", () => {
    const b = budgetFor({ today: "2026-11-09", budgetUsd: 20, settings, ledger: [line({ usd: 2 }), line({ job: "onboard", key: "onboard/JP", usd: 1.5 })] });
    expect(b).toMatchObject({ upkeepPool: 13, buildPool: 4, discoverPool: 3, spentUpkeep: 2, spentBuild: 1.5, spentDiscover: 0, upkeepLeft: 11, buildLeft: 2.5, discoverLeft: 3, daysLeft: 22, released: false });
    expect(b.todayUpkeep).toBeCloseTo(11 / 22, 2);
    // Discovery is paced: by the end of the 9th of 30 days it may have spent 9/30 of its US$3.
    expect(b.todayDiscover).toBeCloseTo(0.9, 2);
  });

  test("in the month's last week upkeep and new countries share what is left, upkeep planned first", () => {
    const b = budgetFor({ today: "2026-11-25", budgetUsd: 20, settings, ledger: [line({ job: "onboard", key: "onboard/JP", usd: 1.5, day: "2026-11-03" })] });
    expect(b).toMatchObject({ released: true, upkeepLeft: 18.5, buildLeft: 18.5, daysLeft: 6 });
    expect(b.todayUpkeep).toBeCloseTo(18.5 / 6, 2);
  });

  test("job costs come from the ledger once three jobs of a kind are on record", () => {
    const three = [1, 2, 3].map((d) => line({ day: `2026-11-0${d}`, key: `AA/f${d}`, usd: 0.3 }));
    expect(jobCosts(three.slice(0, 2), settings.default_job_usd).verify).toBe(settings.default_job_usd.verify);
    expect(jobCosts(three, settings.default_job_usd).verify).toBe(0.3);
    // Policy, onboarding, then up to 5 classifications and 5 date top-ups.
    expect(buildEstimate(settings.default_job_usd, settings, false, true)).toBeCloseTo(0.03 + 1.2 + 5 * (0.3 + 0.12), 6);
    // A draft that fell short before: a discovery of festivals it lacks instead of the onboarding.
    expect(buildEstimate(settings.default_job_usd, settings, true, false)).toBeCloseTo(0.7 + 5 * (0.3 + 0.12), 6);
  });
});

describe("what is due today", () => {
  const RULE = (start: string, end: string) => ({ type: "fixed", start, end });
  // TODAY is 2026-10-26: «soon» starts in 10 days, «far» in about 200.
  const aa = nation("AA", [fest("AA", "soon", RULE("11-05", "11-07")), fest("AA", "far", RULE("05-15", "05-16"))]);

  test("never checked: due; checked within its interval (by the ledger, even with nothing found): not again", () => {
    expect(dueToday([aa], config, [], TODAY).map((d) => [d.item.slug, d.band, d.kind])).toEqual([
      ["soon", "verify-45", "verify"],
      ["far", "verify-far", "verify"],
    ]);
    const checked = [line({ key: "AA/soon", day: "2026-10-24" }), line({ key: "AA/far", day: "2026-10-01" })];
    // «soon» was verified 2 days ago (weekly cadence) but is under 45 days: a sweep is due every 7 days, not yet.
    expect(dueToday([aa], config, checked, TODAY)).toEqual([]);
    const later = dueToday([aa], config, checked, "2026-11-01");
    expect(later.map((d) => [d.item.slug, d.kind])).toEqual([["soon", "verify"]]);
  });

  test("inside the last week a sweep is due daily for tier 1 once the weekly check is done", () => {
    const checked = [line({ key: "AA/soon", day: "2026-10-31" }), line({ key: "AA/far", day: "2026-10-31" }), line({ job: "sweep", key: "AA/soon", day: "2026-11-01" })];
    const due = dueToday([aa], config, checked, "2026-11-03");
    // «soon» is tier 2 or lower here (no score), so every other day: swept on 11-01, due on 11-03.
    expect(due.map((d) => [d.item.slug, d.band, d.kind])).toEqual([["soon", "sweep-7", "sweep"]]);
  });

  test("drafts get no upkeep; they are built through requests", () => {
    expect(dueToday([{ ...aa, status: "borrador" }], config, [], TODAY)).toEqual([]);
  });
});

describe("makePlan", () => {
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    today: "2026-11-09",
    budgetUsd: 20,
    settings,
    countries: [country("CO"), country("BR"), { ...country("BO"), status: "borrador" }],
    config,
    requests: [],
    ledger: [],
    configured: new Set(["CO", "BR", "BO", "PE", "MX"]),
    maxFestivals: 40,
    ...over,
  });

  test("upkeep stays inside today's share; the rest waits for another day", () => {
    const plan = makePlan(input());
    // Discoveries are paid from their own share, not from today's upkeep.
    const spent = plan.verify.length * (plan.costs.verify + plan.costs.followup * 0.3) + plan.sweep.length * plan.costs.sweep;
    expect(spent).toBeLessThanOrEqual(plan.budget.todayUpkeep + 1e-9);
    expect(plan.verify.length + plan.sweep.length + plan.deferred.length).toBeGreaterThan(plan.verify.length);
    expect(plan.verify.every((i) => i.country === "CO" || i.country === "BR")).toBe(true);
  });

  test("builds: oldest request first, within the new-country share and the per-run limit; live ones are skipped", () => {
    const req = (cc: string, at: string): CountryRequest => ({ country: cc, requested_at: at, status: "queued", attempts: 0 });
    // US$40: a new-country share of US$8 holds BO's retry (with its discovery) and JP's first build.
    const plan = makePlan(input({ budgetUsd: 40, requests: [req("JP", "2026-11-03"), req("BO", "2026-11-01"), req("CO", "2026-10-01"), req("FR", "2026-11-04")] }));
    expect(plan.builds.map((b) => [b.country, b.hasFile, b.needsPolicy])).toEqual([["BO", true, false], ["JP", false, true]]);
    expect(plan.waiting).toEqual([{ country: "FR", reason: "per_run_limit", estimate: buildEstimate(plan.costs, settings, false, true), until: "2026-11-09" }]);
    const broke = makePlan(input({ requests: [req("JP", "2026-11-03")], ledger: [line({ job: "onboard", key: "onboard/XX", usd: 5.5 })] }));
    expect(broke.builds).toEqual([]);
    expect(broke.waiting[0]).toMatchObject({ country: "JP", reason: "budget", until: "2026-12-01" });
  });

  test("a retry waits until its date", () => {
    const retry: CountryRequest = { country: "JP", requested_at: "2026-10-01", status: "retry", attempts: 1, retry_after: "2026-11-20" };
    expect(makePlan(input({ requests: [retry] })).builds).toEqual([]);
    expect(makePlan(input({ requests: [retry], today: "2026-11-20" })).builds.map((b) => b.country)).toEqual(["JP"]);
  });

  test("projection: the cost of one country at full cadence, and the stretch that fits a small budget", () => {
    const live = [country("CO"), country("BR")];
    const roomy = projection(live, config, settings.default_job_usd, "2026-11-09", 100);
    expect(roomy.stretch).toBe(1);
    expect(roomy.perCountry).toBeGreaterThan(0);
    expect(roomy.countriesSupported).toBe(Math.floor(100 / roomy.perCountry));
    const tight = projection(live, config, settings.default_job_usd, "2026-11-09", 2);
    expect(tight.stretch).toBeGreaterThan(1);
    expect(tight.stretch).toBeLessThanOrEqual(MAX_STRETCH);
  });
});

describe("request lifecycle (nextRequest)", () => {
  const t = "2026-11-09";
  test("request → queued; built and published → live; short of R2 → retry in 30 days → gave up on the third try", () => {
    const q = nextRequest(undefined, "JP", { type: "request", today: t, issue: 7 }, rules);
    expect(q).toEqual({ country: "JP", requested_at: t, status: "queued", attempts: 0, issue: 7 });
    expect(nextRequest(q, "JP", { type: "built", today: t, published: true }, rules)).toMatchObject({ status: "live", attempts: 1, live_since: t });
    const r1 = nextRequest(q, "JP", { type: "built", today: t, published: false, note: "1 of 3" }, rules);
    expect(r1).toMatchObject({ status: "retry", attempts: 1, retry_after: "2026-12-09", note: "1 of 3" });
    const r2 = nextRequest(r1, "JP", { type: "built", today: "2026-12-09", published: false }, rules);
    const r3 = nextRequest(r2, "JP", { type: "built", today: "2027-01-08", published: false }, rules);
    expect([r2.status, r3.status, r3.attempts, r3.retry_after]).toEqual(["retry", "gave_up", 3, undefined]);
  });

  test("asking again starts over; an error is not an attempt; publishing on its own makes it live", () => {
    const gaveUp: CountryRequest = { country: "JP", requested_at: "2026-01-01", status: "gave_up", attempts: 3, note: "x" };
    expect(nextRequest(gaveUp, "JP", { type: "request", today: t, issue: 9 }, rules)).toEqual({ country: "JP", requested_at: t, status: "queued", attempts: 0, issue: 9 });
    const q: CountryRequest = { country: "JP", requested_at: t, status: "queued", attempts: 0 };
    expect(nextRequest(q, "JP", { type: "error", today: t, note: "R10: budget" }, rules)).toEqual({ ...q, note: "R10: budget" });
    expect(nextRequest(q, "JP", { type: "published", today: t }, rules)).toMatchObject({ status: "live", live_since: t });
    const live = { ...q, status: "live" as const };
    expect(nextRequest(live, "JP", { type: "request", today: t, issue: 3 }, rules)).toEqual({ ...live, issue: 3 });
  });

  test("due: queued in request order, then retries whose date came", () => {
    const r = (country: string, status: CountryRequest["status"], requested_at: string, retry_after?: string): CountryRequest => ({ country, status, requested_at, attempts: 0, ...(retry_after ? { retry_after } : {}) });
    const list = [r("FR", "retry", "2026-01-01", "2026-11-01"), r("JP", "queued", "2026-11-05"), r("IT", "queued", "2026-11-01"), r("DE", "retry", "2026-01-01", "2026-12-01"), r("CO", "live", "2026-01-01")];
    expect(requestsDue(list, "2026-11-09").map((x) => x.country)).toEqual(["IT", "JP", "FR"]);
  });

  test("the country of a «build-country» issue, from its form field or its title", () => {
    expect(countryFromIssue("Build a country", "### Country code (código de país)\n\njp\n\n### Why\n\nTrip")).toBe("JP");
    expect(countryFromIssue("Build: FR", "")).toBe("FR");
    expect(countryFromIssue("Japan please", "no code here")).toBeNull();
  });
});

describe("intake", () => {
  test("any code of the site's country list is accepted; anything else is refused with the reason", () => {
    expect(intakeProblem("jp")).toBeNull();
    expect(intakeProblem("XK")).toBeNull();
    expect(intakeProblem("ZZ")).toMatch(/not a country code the site knows/);
    expect(intakeProblem("Japan")).toMatch(/not a two-letter/);
  });

  test("pipelineArgs: --request, an issue's env vars (never argv), --plan", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(pipelineArgs(["--request=jp", "--issue=4"], {}, now)).toMatchObject({ request: { country: "JP", issue: 4 }, planOnly: false });
    expect(pipelineArgs([], { ISSUE_NUMBER: "12", ISSUE_TITLE: "Build a country", ISSUE_BODY: "### Country code\n\nfr\n" }, now).request).toEqual({ country: "FR", issue: 12 });
    // An issue without a code is still a request: intake refuses it and says so on the issue.
    expect(pipelineArgs([], { ISSUE_NUMBER: "13", ISSUE_TITLE: "hi", ISSUE_BODY: "hello" }, now).request).toEqual({ country: "??", issue: 13 });
    expect(pipelineArgs(["--plan"], {}, now)).toMatchObject({ planOnly: true });
    expect("request" in pipelineArgs([], {}, now)).toBe(false);
    expect(pipelineArgs([], { SITE_URL: "https://x.github.io/T/" }, now).siteUrl).toBe("https://x.github.io/T/");
    expect(() => pipelineArgs(["--request=JPN"], {}, now)).toThrow(UsageError);
  });
});

describe("holds", () => {
  const flagged = accepted({ verdict: "flagged", flags: ["retenido: x"], slug: "fest", field: "start" });
  test("a new flag replaces the old hold on the field; an applied or confirmed field and old holds drop out", () => {
    const old = { ...holdFor(accepted({ slug: "fest", field: "start" }), "2026-10-01"), new: "2027-03-01" };
    const stale = { ...holdFor(accepted({ slug: "other", field: "end" }), "2026-06-01") };
    const kept = { ...holdFor(accepted({ slug: "kept", field: "end" }), "2026-11-01") };
    const done = holdFor(accepted({ slug: "done", field: "status" }), "2026-11-01");
    const merged = mergeHolds([old, stale, kept, done], [flagged], [accepted({ slug: "done", field: "status" })], "2026-11-09");
    expect(merged.map((h) => `${h.slug}/${h.field}@${h.day}`)).toEqual(["fest/start@2026-11-09", "kept/end@2026-11-01"]);
  });

  test("the issue body escapes web text and links only https sources", () => {
    const md = renderHolds([holdFor({ ...flagged, name: "Fest <script>", quote: "x" }, "2026-11-09")], "2026-11-09");
    expect(md).toContain("Fest \\<script\\>");
    expect(md).toContain("[\\[1\\]](https://example.org/fest)");
    expect(renderHolds([], "2026-11-09")).toContain("Nothing is held right now.");
  });
});

describe("auto-approval safeguards", () => {
  const confirmed = nation("AA", [fest("AA", "fest", { type: "fixed", start: "03-01", end: "03-05" }, { "2027": edition({ start: "2027-03-01", end: "2027-03-05", status: "confirmada", confidence: "oficial", sources: [source("https://example.org/a")] }) })]);

  test("moving a confirmed date or calling an edition off needs two independent sites", () => {
    const move = accepted({ field: "start", old: "2027-03-01", new: "2027-03-02" });
    expect(needsTwoSources(move, confirmed)).toBe(true);
    expect(needsTwoSources(accepted({ field: "status", new: "cancelada" }), undefined)).toBe(true);
    expect(needsTwoSources(accepted({ field: "start" }), nation("AA", [fest("AA", "fest", { type: "fixed", start: "03-01", end: "03-05" })]))).toBe(false);
    const [held] = holdRisky([move], [confirmed]);
    expect(held).toMatchObject({ verdict: "flagged" });
    expect(held!.flags.join()).toMatch(/dos fuentes de sitios distintos/);
    const two = accepted({ field: "start", old: "2027-03-01", new: "2027-03-02", sources: [cited("https://example.org/a"), cited("https://news.example.net/b")] });
    expect(independentSources(two)).toBe(2);
    expect(holdRisky([two], [confirmed])[0]!.verdict).toBe("accepted");
  });

  test("a run that moves more than half of a country's dates is held whole", () => {
    const slugs = ["a", "b", "c", "d"];
    const aa = nation("AA", slugs.map((s) => fest("AA", s, { type: "fixed", start: "03-01", end: "03-05" }, { "2027": edition({ start: "2027-03-01", end: "2027-03-05", sources: [source("https://example.org/x")] }) })));
    const moves = slugs.slice(0, 3).map((s) => accepted({ slug: s, field: "start", old: "2027-03-01", new: "2027-03-02" }));
    const out = holdRisky([...moves, accepted({ slug: "d", field: "score.convocatoria", old: null, new: 5 })], [aa]);
    expect(out.every((c) => c.verdict === "flagged")).toBe(true);
    expect(out[0]!.flags.join()).toMatch(/más de la mitad de las fechas de AA/);
    expect(holdRisky(moves.slice(0, 2), [aa]).every((c) => c.verdict === "accepted")).toBe(true);
  });
});

describe("the R2 publish gate", () => {
  test("Peru's draft passes on its own; Bolivia's does not yet", () => {
    const policies = new Map(["PE", "BO"].map((cc) => [cc, loadDomainPolicy(REPO, cc)]));
    const pe = { ...country("PE"), status: "borrador" as const };
    const bo = { ...country("BO"), status: "borrador" as const };
    expect(readiness(pe, policies, TODAY)).toMatchObject({ ok: true, needed: 3 });
    expect(readiness(bo, policies, TODAY)).toMatchObject({ ok: false, sourced: 2 });
    const { countries, promoted } = promoteReady([pe, bo], policies, TODAY);
    expect(promoted).toEqual(["PE"]);
    expect(countries.map((c) => c.status)).toEqual(["publicado", "borrador"]);
  });

  test("a build tops up only festivals without a sourced date, nearest first", () => {
    const bo = { ...country("BO"), status: "borrador" as const };
    const queue = topUpQueue(bo, config, loadDomainPolicy(REPO, "BO"), TODAY, 5);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.map((i) => i.slug)).toContain("urkupina");
    expect(queue.map((i) => i.daysToStart)).toEqual([...queue.map((i) => i.daysToStart)].sort((a, b) => a - b));
  });
});

describe("source policy for a country nobody configured", () => {
  test("only bare hostnames; government domains and UNESCO always; no social network or reseller as press", () => {
    expect([cleanHost("WWW.Asahi.com"), cleanHost("https://x.jp/a"), cleanHost("bad host"), cleanHost("nhk.or.jp.")]).toEqual(["asahi.com", null, null, "nhk.or.jp"]);
    const files = policyFiles("JP", { country: "JP", official: ["japan.travel", "facebook.com"], press: ["asahi.com", "www.nhk.or.jp", "wikipedia.org", "japan.travel", "viagogo.com", "https://bad"], blocked: ["ticketfarm.jp", "go.jp"] });
    expect(files.official.domains).toEqual([...defaultGovernmentDomains("JP"), "japan.travel"]);
    expect(files.sources.A).toEqual(files.official.domains);
    expect(files.sources.B).toEqual(["asahi.com", "nhk.or.jp"]);
    expect(files.sources.blocked).toEqual(["viagogo.com", "stubhub.com", "allevents.in", "happeningnext.com", "ticketfarm.jp"]);
    expect(policyFiles("JP", null).sources.B).toEqual([]);
  });

  test("drafted with one call; a failed call writes the government-only fallback", async () => {
    const root = tempRepo({ countries: [] });
    const transport = replayTransport({ "policy/JP": { research: [], extract: [json({ country: "JP", official: ["japan.travel"], press: ["asahi.com"], blocked: [] })] } });
    const gate = { beforeCall: () => {}, afterCall: () => {} };
    const ok = await draftSourcePolicy(transport, gate, { root, country: "JP", countryName: "Japan", localLanguage: "ja", model: "m" }, memoryLogger());
    expect(ok.drafted).toBe(true);
    expect(transport.calls[0]!.ctx).toEqual({ key: "policy/JP", kind: "extract" });
    expect(readJsonFile<{ B: string[] }>(join(root, "config", "sources", "jp.json")).B).toEqual(["asahi.com"]);
    const failed = await draftSourcePolicy(replayTransport({}), gate, { root, country: "FR", countryName: "France", localLanguage: "fr", model: "m" }, memoryLogger());
    expect(failed.drafted).toBe(false);
    expect(readJsonFile<{ A: string[]; B: string[] }>(join(root, "config", "sources", "fr.json"))).toMatchObject({ A: defaultGovernmentDomains("FR"), B: [] });
  });
});

describe("country facts for every country the site lists", () => {
  test("all 238 codes have a zone the platform knows, a region and a local language", () => {
    const missing = ISO_COUNTRIES.filter((cc) => !countryInfo(cc));
    expect(missing).toEqual([]);
    for (const cc of ISO_COUNTRIES) expect(() => new Intl.DateTimeFormat("en", { timeZone: countryInfo(cc)!.timezone })).not.toThrow();
  });

  test("hand-checked facts win; others come from CLDR, with the capital's zone where there are several", () => {
    expect(countryInfo("PE")).toMatchObject({ timezone: "America/Lima", local: "es" });
    expect(deriveCountry("JP")).toMatchObject({ lang: "en", local: "ja", timezone: "Asia/Tokyo", region: "asia", names: { en: "Japan", es: "Japón" } });
    expect(countryInfo("CA")).toMatchObject({ timezone: "America/Toronto", region: "norteamerica" });
    expect(countryInfo("RU")).toMatchObject({ timezone: "Europe/Moscow", local: "ru", region: "europa" });
    expect(countryInfo("MA")).toMatchObject({ local: "ar", region: "africa" });
    expect(localLangFor("BR")).toBe("pt");
    expect(countryInfo("ZZ")).toBeNull();
  });

  test("news words and status stems in the local language", () => {
    expect(newsTerms("fr")).toEqual(["annulé", "reporté", "suspendu", "cancelled", "postponed", "suspended"]);
    expect(newsTerms("tlh")).toEqual(["cancelled", "postponed", "suspended"]);
    expect(quoteSupportsStatus("Das Fest wurde abgesagt", "cancelada")).toBe(true);
    expect(quoteSupportsStatus("今年の祭りは中止となりました", "cancelada")).toBe(true);
    expect(quoteSupportsStatus("축제가 연기되었습니다", "aplazada")).toBe(true);
    expect(quoteSupportsStatus("Le festival est reporté à juin", "aplazada")).toBe(true);
    expect(quoteSupportsStatus("as reported by the press", "aplazada")).toBe(false);
  });
});

describe("dates in any language (R3)", () => {
  test.each([
    ["fr", "du 14 au 18 février 2027", "2027-02-14", "start"],
    ["fr", "du 14 au 18 février 2027", "2027-02-18", "end"],
    ["de", "vom 14. bis 18. Februar 2027", "2027-02-18", "end"],
    ["de", "am 14.02.2027", "2027-02-14", "any"],
    ["it", "dal 14 al 18 febbraio 2027", "2027-02-18", "end"],
    ["ru", "с 14 по 18 февраля 2027 года", "2027-02-14", "start"],
    ["ja", "2027年2月14日～18日", "2027-02-18", "end"],
    ["zh", "2027年2月14日至3月2日", "2027-03-02", "end"],
    ["ko", "2027년 2월 14일부터 18일까지", "2027-02-18", "end"],
    ["th", "14 กุมภาพันธ์ 2570", "2027-02-14", "any"],
    ["ar", "١٤ فبراير ٢٠٢٧", "2027-02-14", "any"],
    ["hi", "14 फ़रवरी 2027", "2027-02-14", "any"],
  ] as const)("%s: «%s» states %s (%s)", (lang, quote, iso, role) => {
    expect(quoteStatesDate(quote, lang, iso, role)).toBe(true);
  });

  test("the year still has to match, and the pilot languages read only their own months", () => {
    expect(quoteStatesDate("14 กุมภาพันธ์ 2570", "th", "2026-02-14", "any")).toBe(false);
    expect(quoteStatesDate("du 14 au 18 février 2027", "fr", "2027-02-15", "start")).toBe(false);
    expect(quoteStatesDate("February 6-9, 2027", "es", "2027-02-06", "start")).toBe(false);
    expect([hasDateReader("fr"), hasDateReader("ja"), hasDateReader("es-CO"), hasDateReader("xx")]).toEqual([true, true, true, false]);
  });
});

describe("independent sources worldwide", () => {
  test("generic second-level labels under any ccTLD keep two outlets apart", () => {
    expect(registrableDomain("www3.nhk.or.jp")).toBe("nhk.or.jp");
    expect(registrableDomain("news.asahi.co.jp")).toBe("asahi.co.jp");
    expect(registrableDomain("a.b.gov.za")).toBe("b.gov.za");
    expect(registrableDomain("blog.example.de")).toBe("example.de");
    expect(registrableDomain("x.eltiempo.com")).toBe("eltiempo.com");
  });
});
