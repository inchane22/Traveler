import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { findLeaks, scan, ScanError, trackedFiles } from "../../scripts/check-secrets.ts";
import { readRequests } from "../../scripts/lib/requests.ts";
import { buildIndex, loadCountries, publicChangelog } from "../../scripts/build-data.ts";
import { loadDomainPolicy } from "../../scripts/lib/domains.ts";
import type { ScoringConfig } from "../../src/score.ts";

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;

describe("check-secrets (R8)", () => {
  const prefix = ["sk", "ant", ""].join("-");
  test("flags a key-shaped token, ignores the bare prefix in docs", () => {
    const files: Record<string, string> = {
      "leak.js": `const k = "${prefix}api03-${"a".repeat(40)}"`,
      "PRD.md": `el build falla si encuentra el prefijo \`${prefix}\``,
    };
    expect(findLeaks(Object.keys(files), (p) => files[p] ?? "")).toEqual(["leak.js"]);
  });

  test("also catches GitHub tokens, PEM private keys and assigned archive or trap secrets (SEC-10)", () => {
    const j = (...p: string[]) => p.join("");
    const files: Record<string, string> = {
      "a.txt": `token ${j("gh", "p_")}${"A".repeat(36)}`,
      "b.txt": `${j("github", "_pat_")}${"a".repeat(60)}`,
      "c.pem": `-----${j("BEGIN ", "RSA PRIVATE KEY")}-----`,
      "d.env": `${j("TRAP", "_SECRET")}=${"f".repeat(32)}`,
      ".env.example": `${j("ARCHIVE", "_ACCESS_KEY")}=\n${j("ARCHIVE", "_SECRET_KEY")}=\n`,
      ".env.op": `${j("TRAP", "_SECRET")}=op://Dev/traveler/${j("TRAP", "_SECRET")}`,
      "ci.yml": `${j("TRAP", "_SECRET")}: \${{ secrets.${j("TRAP", "_SECRET")} }}`,
    };
    expect(findLeaks(Object.keys(files), (p) => files[p] ?? "")).toEqual(["a.txt", "b.txt", "c.pem", "d.env"]);
  });

  test("fails closed: a git failure, an empty listing or an unreadable file is never a clean scan (code-F6)", () => {
    expect(() => trackedFiles(() => { throw new Error("fatal: detected dubious ownership"); })).toThrow(ScanError);
    expect(() => trackedFiles(() => "")).toThrow(/no files/);
    expect(trackedFiles(() => "a.ts\0b.ts\0")).toEqual(["a.ts", "b.ts"]);
    const result = scan(["ok.txt", "gone.txt"], (p) => {
      if (p === "gone.txt") throw new Error("EACCES");
      return "nothing here";
    });
    expect(result).toEqual({ leaks: [], unreadable: ["gone.txt"] });
  });
});

describe("build-data", () => {
  // data/ is rewritten by the pipeline every day: value checks read the frozen copy; the
  // committed-index check below must read data/ itself.
  const countries = loadCountries("tests/fixtures/site/countries");
  const live = loadCountries("data/countries");
  test("every country file validates and the index lists tier-1 festivals", () => {
    expect(live.length).toBeGreaterThan(0);
    const index = buildIndex(countries, config, false);
    expect(index.countries.every((c) => c.status === "publicado")).toBe(true);
    expect(index.tier1).toContain("CO/carnaval-barranquilla");
    expect(index.slugs["independencia-cartagena"]).toBe("CO");
  });

  test("drafts never appear in the production index", () => {
    const draft = { ...countries[0]!, country: "ZZ", status: "borrador" as const, festivals: [] };
    expect(buildIndex([...countries, draft], config, false).countries.map((c) => c.code)).not.toContain("ZZ");
    expect(buildIndex([...countries, draft], config, true).countries.map((c) => c.code)).toContain("ZZ");
  });

  test("the committed data/index.json is up to date", () => {
    const committed = JSON.parse(readFileSync("data/index.json", "utf8"));
    // The same policies and requests build-data's main uses, so a source without a declared tier cannot diverge.
    const policies = new Map(live.map((c) => [c.country, loadDomainPolicy(".", c.country)]));
    expect(committed).toEqual(buildIndex(live, config, false, policies, readRequests(".")));
  });

  test("the site's change log leaves out countries it does not serve (a draft's changes stay private)", () => {
    const entry = (country: string) => ({ date: "2026-11-09", country, slug: "fest", field: "start", old: null, new: "2027-01-04", source_urls: ["https://example.org/a"] });
    expect(publicChangelog([entry("CO"), entry("MX"), entry("PE")], new Set(["CO", "PE"])).map((e) => e.country)).toEqual(["CO", "PE"]);
  });

  test("requested countries that are not live yet are listed, so their page says where the build is", () => {
    const req = (country: string, status: "queued" | "retry" | "live" | "gave_up", retry_after?: string) => ({ country, status, requested_at: "2026-11-01", attempts: 0, ...(retry_after ? { retry_after } : {}) });
    const index = buildIndex(countries, config, false, undefined, [req("JP", "queued"), req("FR", "retry", "2026-12-01"), req("CO", "live"), req("IT", "gave_up"), req("BR", "queued")]);
    // BR is served already (a stale request never hides a live country); CO is live.
    expect(index.requests).toEqual([{ code: "FR", status: "retry", retry_after: "2026-12-01" }, { code: "IT", status: "gave_up" }, { code: "JP", status: "queued" }]);
  });
});
