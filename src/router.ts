// Hash routes (docs/architecture.md «Runtime hooks for tests»). Pure: parse and serialize only;
// the app listens to `hashchange`. Every explorer filter lives in the hash query, so a link
// reproduces the view and the browser Back button restores the previous filters (RF-03).
import { parseISODate, type ISO } from "./dates.ts";
import type { FestivalType } from "./schema.ts";

export const FESTIVAL_TYPES: readonly FestivalType[] = ["carnaval", "musica", "tradicion_religiosa", "cosecha_temporada", "fiesta_nacional"];
export const REGIONS = ["sudamerica", "centroamerica_caribe", "norteamerica", "europa", "asia", "africa", "oceania"] as const;
export type RegionId = (typeof REGIONS)[number];

export type SortOrder = "date" | "near";

export interface ExploreState {
  countries: string[];
  months: string[];
  types: FestivalType[];
  tier2: boolean;
  from?: ISO;
  to?: ISO;
  sort: SortOrder;
}

export interface HomeQuery {
  tier2: boolean;
}

export type Route =
  | { name: "home"; query: HomeQuery }
  | { name: "country"; code: string; query: HomeQuery }
  | { name: "region"; region: RegionId; query: HomeQuery }
  | { name: "explore"; filters: ExploreState }
  | { name: "festival"; slug: string }
  | { name: "saved" }
  | { name: "settings" }
  | { name: "about" }
  | { name: "notfound"; path: string };

export const EMPTY_FILTERS: ExploreState = { countries: [], months: [], types: [], tier2: false, sort: "date" };

const isISO = (v: string): boolean => {
  try {
    parseISODate(v);
    return true;
  } catch {
    return false;
  }
};
// A month is only kept when its first day is a civil date (year 0000 is not: BE-05).
const isMonth = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v) && isISO(`${v}-01`);
const isType = (v: string): v is FestivalType => (FESTIVAL_TYPES as readonly string[]).includes(v);
export const isRegion = (v: unknown): v is RegionId => typeof v === "string" && (REGIONS as readonly string[]).includes(v);

const list = (q: URLSearchParams, key: string): string[] =>
  [...new Set((q.get(key) ?? "").split(",").map((v) => v.trim()).filter(Boolean))];

export function parseFilters(q: URLSearchParams): ExploreState {
  let from = q.get("desde") ?? undefined;
  let to = q.get("hasta") ?? undefined;
  if (from && !isISO(from)) from = undefined;
  if (to && !isISO(to)) to = undefined;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    countries: list(q, "pais").map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).sort(),
    months: list(q, "mes").filter(isMonth).sort(),
    types: FESTIVAL_TYPES.filter((t) => list(q, "tipo").includes(t)),
    tier2: q.get("nivel") === "2",
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sort: q.get("orden") === "cerca" ? "near" : "date",
  };
}

/** Canonical query string; values are validated tokens, so commas stay readable. */
export function serializeFilters(f: ExploreState): string {
  const parts: string[] = [];
  if (f.countries.length) parts.push(`pais=${[...f.countries].sort().map((c) => c.toLowerCase()).join(",")}`);
  if (f.months.length) parts.push(`mes=${[...f.months].sort().join(",")}`);
  if (f.types.length) parts.push(`tipo=${FESTIVAL_TYPES.filter((t) => f.types.includes(t)).join(",")}`);
  if (f.tier2) parts.push("nivel=2");
  if (f.from) parts.push(`desde=${f.from}`);
  if (f.to) parts.push(`hasta=${f.to}`);
  if (f.sort === "near") parts.push("orden=cerca");
  return parts.join("&");
}

export function hasActiveFilters(f: ExploreState): boolean {
  return serializeFilters({ ...f, sort: "date" }) !== "";
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const path = pathPart.replace(/\/+$/, "") || "/";
  const q = new URLSearchParams(queryPart);
  const segments = path.split("/").filter(Boolean).map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  const home: HomeQuery = { tier2: q.get("nivel") === "2" };

  if (segments.length === 0) return { name: "home", query: home };
  const [head, arg] = segments;
  if (segments.length === 1) {
    if (head === "explorar") return { name: "explore", filters: parseFilters(q) };
    if (head === "guardadas") return { name: "saved" };
    if (head === "ajustes") return { name: "settings" };
    if (head === "datos") return { name: "about" };
  }
  if (segments.length === 2 && arg) {
    if (head === "pais" && /^[a-z]{2}$/i.test(arg)) return { name: "country", code: arg.toUpperCase(), query: home };
    if (head === "region" && isRegion(arg)) return { name: "region", region: arg, query: home };
    if (head === "fiesta" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(arg)) return { name: "festival", slug: arg };
  }
  return { name: "notfound", path };
}

export function serializeRoute(route: Route): string {
  const withHome = (path: string, q: HomeQuery) => (q.tier2 ? `#${path}?nivel=2` : `#${path}`);
  switch (route.name) {
    case "home":
      return withHome("/", route.query);
    case "country":
      return withHome(`/pais/${route.code.toLowerCase()}`, route.query);
    case "region":
      return withHome(`/region/${route.region}`, route.query);
    case "explore": {
      const q = serializeFilters(route.filters);
      return q ? `#/explorar?${q}` : "#/explorar";
    }
    case "festival":
      return `#/fiesta/${route.slug}`;
    case "saved":
      return "#/guardadas";
    case "settings":
      return "#/ajustes";
    case "about":
      return "#/datos";
    case "notfound":
      return `#${route.path}`;
  }
}

/** Reads `?today=YYYY-MM-DD` from the page URL (test hook); null when absent or invalid. */
export function todayOverride(search: string): ISO | null {
  const value = new URLSearchParams(search).get("today");
  return value && isISO(value) ? value : null;
}
