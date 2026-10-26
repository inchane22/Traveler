import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { changesInProposal, main as checkTrap } from "../../scripts/check-trap.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { emptyMonth, memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { runRefresh } from "../../scripts/lib/refresh-run.ts";
import { canonicalValue, findTraps, fingerprint, makeTrap, parseFingerprints } from "../../scripts/lib/trap.ts";
import { coPolicy, config, country, githubOutput, REFRESH_FIXTURES, refreshOptions, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";

// Test-only value; the real one lives in the TRAP_SECRET GitHub secret.
const SECRET = "test-trap-secret-not-real";

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("trap fingerprints (R12)", () => {
  test("HMAC-SHA256 over country|slug|field|new, stable and secret-dependent", () => {
    const c = { country: "CO", slug: "carnaval-barranquilla", field: "end", new: "2027-02-11" };
    expect(fingerprint(SECRET, c)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(SECRET, c)).toBe(fingerprint(SECRET, { ...c }));
    expect(fingerprint("other", c)).not.toBe(fingerprint(SECRET, c));
    expect(canonicalValue(7)).toBe("7");
    expect(canonicalValue(undefined)).toBe("null");
    const fp = fingerprint(SECRET, c);
    expect(parseFingerprints(` ${fp.toUpperCase()} , nope,`)).toEqual(new Set([fp]));
    expect(findTraps(SECRET, new Set([fp]), [c, { ...c, new: "2027-02-09" }])).toEqual([c]);
  });

  test("the trap moves an upcoming dated tier-1 end date two days, with a quote no source holds", () => {
    const policies = new Map([["CO", coPolicy]]);
    const trap = makeTrap({ secret: SECRET, month: "2026-10", today: TODAY, countries: [country("CO")], config, policies });
    expect(trap).toMatchObject({ country: "CO", slug: "carnaval-barranquilla", field: "end", old: "2027-02-09", new: "2027-02-11", tier: 1, verdict: "accepted" });
    expect(trap!.quote).toMatch(/11 de febrero de 2027/);
    expect(makeTrap({ secret: SECRET, month: "2026-10", today: "2027-06-01", countries: [country("CO")], config, policies })).toBeNull();
  });
});

describe("trap inside a refresh run and check-trap", () => {
  async function run(root: string, usage = memoryUsageStore()) {
    const out = join(root, `gh-output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    const result = await runRefresh(refreshOptions(root, { dryRun: false, trapSecret: SECRET, githubOutput: out }), {
      transport: fixtureDirTransport(REFRESH_FIXTURES),
      archiver: noopArchiver,
      usage,
      log: memoryLogger(),
    });
    return { result, out: githubOutput(out), outPath: out };
  }

  test("first run of the month adds one trap; its fingerprint goes only to $GITHUB_OUTPUT; check-trap fails", async () => {
    const root = tempRepo({ countries: ["co"] });
    const { result, out, outPath } = await run(root);
    const fp = out.trap_fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const trap = result.report!.applied.find((c) => fingerprint(SECRET, c) === fp);
    expect(trap).toMatchObject({ slug: "carnaval-barranquilla", field: "end", new: "2027-02-11" });
    // It is applied like a real change (the confirmation of the same field does not undo it).
    const co = JSON.parse(readFileSync(join(root, "data", "countries", "co.json"), "utf8"));
    expect(co.festivals.find((f: { slug: string }) => f.slug === "carnaval-barranquilla").editions["2027"].end).toBe("2027-02-11");
    expect(result.report!.confirmations.some((c) => c.slug === "carnaval-barranquilla" && c.field === "end")).toBe(false);
    // The fingerprint and the secret are nowhere in the repo copy.
    for (const file of allFiles(root).filter((f) => f !== outPath)) {
      const content = readFileSync(file, "utf8");
      expect(content.includes(fp!), file).toBe(false);
      expect(content.includes(SECRET), file).toBe(false);
    }

    const log = memoryLogger();
    expect(checkTrap([], { TRAP_SECRET: SECRET, TRAP_FINGERPRINTS: `${"0".repeat(64)},${fp}` }, root, log)).toBe(1);
    expect(log.lines.join("\n")).toMatch(/monthly trap change/);
    expect(log.lines.join("\n")).not.toMatch(/carnaval-barranquilla/);
    const verbose = memoryLogger();
    expect(checkTrap(["--verbose"], { TRAP_SECRET: SECRET, TRAP_FINGERPRINTS: fp }, root, verbose)).toBe(1);
    expect(verbose.lines.join("\n")).toMatch(/trap: CO\/carnaval-barranquilla end in data\/changelog.json/);
  });

  test("a later run in the same month adds no trap, and check-trap passes on a clean branch", async () => {
    const root = tempRepo({ countries: ["co"] });
    const { out } = await run(root, memoryUsageStore([emptyMonth("2026-10")]));
    expect(out.trap_fingerprint).toBeUndefined();
    expect(Number(out.changes)).toBeGreaterThan(0);
    const fp = fingerprint(SECRET, { country: "CO", slug: "carnaval-barranquilla", field: "end", new: "2027-02-11" });
    expect(checkTrap([], { TRAP_SECRET: SECRET, TRAP_FINGERPRINTS: fp }, root, memoryLogger())).toBe(0);
  });

  test("check-trap reads one proposals file, skips without a secret, refuses fingerprints without one", () => {
    const root = tempRepo({ countries: [] });
    const fp = fingerprint(SECRET, { country: "CO", slug: "x", field: "end", new: "2027-01-01" });
    writeFileSync(join(root, "p.json"), JSON.stringify({ applied: [{ country: "CO", slug: "x", field: "end", new: "2027-01-01" }], flagged: "nope" }));
    expect(checkTrap(["--proposals=p.json"], { TRAP_SECRET: SECRET, TRAP_FINGERPRINTS: fp }, root, memoryLogger())).toBe(1);
    expect(checkTrap([], { TRAP_SECRET: SECRET, TRAP_FINGERPRINTS: fp }, root, memoryLogger())).toBe(0);
    expect(checkTrap([], {}, root, memoryLogger())).toBe(0);
    expect(checkTrap([], { TRAP_FINGERPRINTS: fp }, root, memoryLogger())).toBe(1);
    expect(checkTrap(["--bogus"], {}, root, memoryLogger())).toBe(2);
    expect(changesInProposal(null)).toEqual([]);
    expect(changesInProposal({ changes: [{ country: "CO" }, { country: "CO", slug: "s", field: "f", new: 1 }] })).toHaveLength(1);
  });
});
