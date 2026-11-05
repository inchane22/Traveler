// RF-09 / RF-11: saved festivals and preferences survive a reload, and the app keeps working
// when the device refuses storage (private mode, blocked site data, quota).
import { describe, expect, test, vi } from "vitest";
import { createStore, defaultStorage, type StorageLike } from "../../src/store.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: StorageLike = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("createStore with working storage", () => {
  test("persists values and reads them back in a new store", () => {
    const storage = memoryStorage();
    const a = createStore(storage);
    a.toggleSaved("carnaval-barranquilla");
    a.set("lang", "en");
    a.set("weekStart", 1);
    a.set("origin", "GB");
    a.set("scope", { kind: "country", code: "CO" });

    const b = createStore(storage);
    expect(b.get("saved")).toEqual(["carnaval-barranquilla"]);
    expect(b.get("lang")).toBe("en");
    expect(b.get("weekStart")).toBe(1);
    expect(b.get("origin")).toBe("GB");
    expect(b.get("scope")).toEqual({ kind: "country", code: "CO" });
    expect(b.persistent()).toBe(true);
  });

  test("toggleSaved adds then removes, and reports the new state", () => {
    const store = createStore(memoryStorage());
    expect(store.toggleSaved("feria-de-cali")).toBe(true);
    expect(store.isSaved("feria-de-cali")).toBe(true);
    expect(store.toggleSaved("feria-de-cali")).toBe(false);
    expect(store.get("saved")).toEqual([]);
  });

  test("keeps the three most recent countries, newest first, without duplicates", () => {
    const store = createStore(memoryStorage());
    for (const code of ["co", "pe", "br", "co", "mx"]) store.pushRecent(code);
    expect(store.get("recent")).toEqual(["MX", "CO", "BR"]);
  });

  test("setting null removes the stored value", () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    store.set("origin", "US");
    store.set("origin", null);
    expect(store.get("origin")).toBeNull();
    expect(storage.data.has("traveler.origin")).toBe(false);
  });

  test("rejects invalid values instead of storing them", () => {
    const store = createStore(memoryStorage());
    store.set("lang", "fr" as never);
    store.set("origin", "peru" as never);
    store.set("weekStart", 3 as never);
    store.set("saved", ["ok-slug", "<script>", "ok-slug"]);
    expect(store.get("lang")).toBeNull();
    expect(store.get("origin")).toBeNull();
    expect(store.get("weekStart")).toBeNull();
    expect(store.get("saved")).toEqual(["ok-slug"]);
  });

  test("ignores corrupt or tampered stored values and stays persistent", () => {
    const storage = memoryStorage({
      "traveler.saved": "{not json",
      "traveler.lang": JSON.stringify("klingon"),
      "traveler.scope": JSON.stringify({ kind: "country", code: "colombia" }),
      "traveler.recent": JSON.stringify(["CO", 7, "PE"]),
    });
    const store = createStore(storage);
    expect(store.get("saved")).toEqual([]);
    expect(store.get("lang")).toBeNull();
    expect(store.get("scope")).toBeNull();
    expect(store.get("recent")).toEqual([]);
    expect(store.persistent()).toBe(true);
  });

  // SEC-14: another page on the same github.io origin can write traveler.* keys.
  test("a stored region scope must be a known region", () => {
    const foreign = createStore(memoryStorage({ "traveler.scope": JSON.stringify({ kind: "region", region: "atlantis" }) }));
    expect(foreign.get("scope")).toBeNull();
    const known = createStore(memoryStorage({ "traveler.scope": JSON.stringify({ kind: "region", region: "sudamerica" }) }));
    expect(known.get("scope")).toEqual({ kind: "region", region: "sudamerica" });
    known.set("scope", { kind: "region", region: "narnia" } as unknown as { kind: "region"; region: "europa" });
    expect(known.get("scope")).toEqual({ kind: "region", region: "sudamerica" });
  });

  test("get returns copies, so callers cannot mutate the store", () => {
    const store = createStore(memoryStorage());
    store.toggleSaved("san-pacho");
    store.get("saved").push("intruso");
    expect(store.get("saved")).toEqual(["san-pacho"]);
  });

  test("notifies subscribers with the changed key until they unsubscribe", () => {
    const store = createStore(memoryStorage());
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set("lang", "pt");
    off();
    store.set("lang", "es");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("lang");
  });
});

describe("createStore when storage throws", () => {
  test("keeps working in memory and reports that it cannot persist", () => {
    const store = createStore(throwing);
    expect(store.persistent()).toBe(false);
    expect(() => store.toggleSaved("carnaval-barranquilla")).not.toThrow();
    expect(store.isSaved("carnaval-barranquilla")).toBe(true);
    store.set("lang", "en");
    expect(store.get("lang")).toBe("en");
  });

  test("a write that fails later (quota) flips persistent() to false", () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    expect(store.persistent()).toBe(true);
    storage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    store.toggleSaved("feria-de-cali");
    expect(store.persistent()).toBe(false);
    expect(store.get("saved")).toEqual(["feria-de-cali"]);
  });

  test("no storage at all behaves like blocked storage", () => {
    const store = createStore(null);
    expect(store.persistent()).toBe(false);
    store.pushRecent("pe");
    expect(store.get("recent")).toEqual(["PE"]);
  });
});

describe("defaultStorage", () => {
  test("returns null when reading localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(defaultStorage()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
