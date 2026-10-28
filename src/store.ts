// Per-device preferences and saved festivals (RF-09, RF-11). localStorage can be missing, full or
// blocked (private mode, sandboxed iframes): every access is wrapped, and an in-memory copy keeps
// the app working for the session when the device refuses to persist.
import type { Lang } from "./schema.ts";
import { isLang } from "./i18n.ts";
import { isRegion, type RegionId } from "./router.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type WeekStart = 1 | 6 | 7;
export type ScopePref = { kind: "world" } | { kind: "region"; region: RegionId } | { kind: "country"; code: string };

export interface Prefs {
  saved: string[];
  lang: Lang | null;
  origin: string | null;
  weekStart: WeekStart | null;
  recent: string[];
  scope: ScopePref | null;
}

const PREFIX = "traveler.";
const MAX_RECENT = 3;
const KEYS: readonly (keyof Prefs)[] = ["saved", "lang", "origin", "weekStart", "recent", "scope"];

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isCountry = (v: unknown): v is string => typeof v === "string" && /^[A-Z]{2}$/.test(v);

function sanitize<K extends keyof Prefs>(key: K, value: unknown): Prefs[K] | undefined {
  switch (key) {
    case "saved":
      return (isStringArray(value) ? [...new Set(value.filter((s) => /^[a-z0-9-]+$/.test(s)))] : undefined) as Prefs[K] | undefined;
    case "recent":
      return (isStringArray(value) ? value.filter(isCountry).slice(0, MAX_RECENT) : undefined) as Prefs[K] | undefined;
    case "lang":
      return (isLang(value) ? value : undefined) as Prefs[K] | undefined;
    case "origin":
      return (isCountry(value) ? value : undefined) as Prefs[K] | undefined;
    case "weekStart":
      return (value === 1 || value === 6 || value === 7 ? value : undefined) as Prefs[K] | undefined;
    case "scope": {
      if (typeof value !== "object" || value === null) return undefined;
      const v = value as Record<string, unknown>;
      if (v.kind === "world") return { kind: "world" } as Prefs[K];
      // Only known regions: localStorage is shared with every page on the same origin.
      if (v.kind === "region" && isRegion(v.region)) return { kind: "region", region: v.region } as Prefs[K];
      if (v.kind === "country" && isCountry(v.code)) return { kind: "country", code: v.code } as Prefs[K];
      return undefined;
    }
    default:
      return undefined;
  }
}

const DEFAULTS: Prefs = { saved: [], lang: null, origin: null, weekStart: null, recent: [], scope: null };

export interface Store {
  get<K extends keyof Prefs>(key: K): Prefs[K];
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  isSaved(slug: string): boolean;
  toggleSaved(slug: string): boolean;
  pushRecent(code: string): void;
  /** False when the device refused to persist; the app keeps working in memory. */
  persistent(): boolean;
  subscribe(listener: (key: keyof Prefs) => void): () => void;
}

/** Resolves localStorage lazily: reading the property itself can throw (blocked site data). */
export function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createStore(storage: StorageLike | null = defaultStorage()): Store {
  let ok = storage !== null;
  const memory: Prefs = { ...DEFAULTS, saved: [], recent: [] };
  const listeners = new Set<(key: keyof Prefs) => void>();

  for (const key of KEYS) {
    let raw: string | null | undefined;
    try {
      raw = storage?.getItem(PREFIX + key);
    } catch {
      ok = false; // the device refuses access: keep going in memory
      continue;
    }
    if (raw === null || raw === undefined) continue;
    try {
      const value = sanitize(key, JSON.parse(raw));
      if (value !== undefined) (memory as unknown as Record<string, unknown>)[key] = value;
    } catch {
      // A corrupt value is ignored (and overwritten on the next write); storage itself still works.
    }
  }

  const write = (key: keyof Prefs): void => {
    try {
      const value = memory[key];
      if (value === null) storage?.removeItem(PREFIX + key);
      else storage?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      ok = false;
    }
  };

  const store: Store = {
    get: (key) => {
      const value = memory[key];
      return (Array.isArray(value) ? [...value] : value) as Prefs[typeof key];
    },
    set: (key, value) => {
      const clean = value === null ? null : sanitize(key, value);
      if (clean === undefined) return;
      (memory as unknown as Record<string, unknown>)[key] = clean ?? DEFAULTS[key];
      write(key);
      for (const l of listeners) l(key);
    },
    isSaved: (slug) => memory.saved.includes(slug),
    toggleSaved: (slug) => {
      const saved = memory.saved.includes(slug) ? memory.saved.filter((s) => s !== slug) : [...memory.saved, slug];
      store.set("saved", saved);
      return saved.includes(slug);
    },
    pushRecent: (code) => {
      const upper = code.toUpperCase();
      store.set("recent", [upper, ...memory.recent.filter((c) => c !== upper)].slice(0, MAX_RECENT));
    },
    persistent: () => ok,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}
