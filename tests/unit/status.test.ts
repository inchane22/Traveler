// Edition status lifecycle (src/status.ts): what each status means agrees with what schema.ts
// needs to store it, so the two tables cannot drift apart.
import { describe, expect, test } from "vitest";
import { Edition, Status } from "../../src/schema.ts";
import { STATUS_TRAITS } from "../../src/status.ts";

const SOURCE = { url: "https://www.pasto.gov.co/", publisher: "Alcaldía de Pasto", accessed: "2026-10-26", tier: "A" };
const stores = (status: Status, sources: unknown[]): boolean => Edition.safeParse({ status, confidence: "oficial", start: "2027-01-02", end: "2027-01-07", sources }).success;

describe("STATUS_TRAITS", () => {
  test("covers every status", () => {
    expect(Object.keys(STATUS_TRAITS).sort()).toEqual([...Status.options].sort());
  });

  test("a status that settles an edition or reaches calendars as news is never stored without a source", () => {
    for (const status of Status.options) {
      const { settled, keepsRuleDays } = STATUS_TRAITS[status];
      expect(stores(status, [SOURCE]), status).toBe(true);
      if (settled || keepsRuleDays) expect(stores(status, []), status).toBe(false);
    }
  });

  test("only a cancellation means the edition does not take place", () => {
    expect(Status.options.filter((s) => !STATUS_TRAITS[s].takesPlace)).toEqual(["cancelada"]);
  });
});
