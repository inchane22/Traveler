// What every screen receives from the app shell.
import type { ISO } from "../dates.ts";
import type { Translate } from "../i18n.ts";
import type { Route } from "../router.ts";
import type { Lang } from "../schema.ts";
import type { Store } from "../store.ts";

export interface Coords {
  lat: number;
  lon: number;
}

export type GeoState = { status: "off" } | { status: "asking" } | { status: "on"; coords: Coords } | { status: "denied" } | { status: "unavailable" };

export interface Ctx {
  t: Translate;
  lang: Lang;
  today: ISO;
  /** First day of the week: Ajustes, else the locale's, else Monday (1 Mon, 6 Sat, 7 Sun). */
  weekStart: 1 | 6 | 7;
  store: Store;
  /** Absolute site URL with trailing slash (for .ics links and webcal feeds). */
  siteUrl: string;
  repo: string;
  route: Route;
  href(route: Route): string;
  navigate(route: Route, opts?: { replace?: boolean }): void;
  /** Re-renders the current screen keeping focus and scroll. */
  refresh(): void;
  geo(): GeoState;
  requestGeo(): void;
  forgetGeo(): void;
  /** Sets the document title (screen name first). */
  title(text: string): void;
  announce(text: string): void;
  /** Async content replaced the skeleton: the app applies pending focus and scroll. */
  settled(): void;
}
