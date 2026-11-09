// RF-14: «Cerca de mí» has one lifecycle (src/geo.ts) that Ajustes and Explorar both read.
import { describe, expect, test } from "vitest";
import { nextGeo, type GeoEvent, type GeoState, type GeoStatus } from "../../src/geo.ts";

const BOGOTA = { lat: 4.711, lon: -74.072 };
const STATES: Record<GeoStatus, GeoState> = {
  off: { status: "off" },
  asking: { status: "asking" },
  on: { status: "on", coords: BOGOTA },
  denied: { status: "denied" },
  unavailable: { status: "unavailable" },
};
const run = (state: GeoState, ...events: GeoEvent[]): GeoState => events.reduce(nextGeo, state);

describe("nextGeo", () => {
  test("a tap asks, and the device's answer turns it on", () => {
    expect(run(STATES.off, { type: "request", supported: true })).toEqual({ status: "asking" });
    expect(run(STATES.off, { type: "request", supported: true }, { type: "located", coords: BOGOTA })).toEqual(STATES.on);
  });

  test("a refusal or a failure says which", () => {
    expect(run(STATES.asking, { type: "failed", reason: "denied" })).toEqual({ status: "denied" });
    expect(run(STATES.asking, { type: "failed", reason: "unavailable" })).toEqual({ status: "unavailable" });
  });

  test("a device without geolocation is unavailable at once, without asking", () => {
    expect(run(STATES.off, { type: "request", supported: false })).toEqual({ status: "unavailable" });
  });

  test.each(["denied", "unavailable"] as const)("after %s, a new tap asks again", (status) => {
    expect(run(STATES[status], { type: "request", supported: true })).toEqual({ status: "asking" });
  });

  test("«Olvidar» turns it off from any state", () => {
    for (const status of ["asking", "on", "denied", "unavailable"] as const) expect(run(STATES[status], { type: "forget" })).toEqual(STATES.off);
  });

  // Same object back: the app shell skips the re-render and the announcement.
  test.each([
    ["a second tap while asking", STATES.asking, { type: "request", supported: true }],
    ["a tap once on", STATES.on, { type: "request", supported: true }],
    ["an answer when nothing was asked", STATES.off, { type: "located", coords: BOGOTA }],
    ["a second answer once on", STATES.on, { type: "located", coords: { lat: 0, lon: 0 } }],
    ["a late refusal once on", STATES.on, { type: "failed", reason: "denied" }],
    ["a failure when nothing was asked", STATES.denied, { type: "failed", reason: "unavailable" }],
    ["«Olvidar» when already off", STATES.off, { type: "forget" }],
  ] as const)("%s changes nothing", (_label, state, event) => {
    expect(nextGeo(state, event)).toBe(state);
  });

  test("an answer that arrives after «Olvidar» does not turn the location back on", () => {
    expect(run(STATES.off, { type: "request", supported: true }, { type: "forget" }, { type: "located", coords: BOGOTA })).toEqual(STATES.off);
  });
});
