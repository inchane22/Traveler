// App shell: wires the pure modules (router, store, i18n) to the DOM, renders the current screen
// into <main>, and keeps focus and scroll where the user expects them across re-renders.
import { todayIn, type ISO } from "./dates.ts";
import { createI18n, detectLang, type I18n, type Messages } from "./i18n.ts";
import { EMPTY_FILTERS, parseHash, serializeRoute, todayOverride, type Route } from "./router.ts";
import type { Lang } from "./schema.ts";
import { createStore, type Store } from "./store.ts";
import { renderAbout } from "./render/about.ts";
import type { Coords, Ctx, GeoState } from "./render/context.ts";
import { renderExplore } from "./render/explore.ts";
import { DEFAULT_REPO, renderFestival } from "./render/festival.ts";
import { localeWeekStart } from "./render/format.ts";
import { renderHome } from "./render/home.ts";
import { loadIndex } from "./render/model.ts";
import { renderSaved } from "./render/saved.ts";
import { renderSettings } from "./render/settings.ts";
import { closeSheet } from "./render/sheet.ts";
import { offlineNotice, renderBottomNav, renderFooter, renderMasthead, renderSkipLink, todayOverrideNotice } from "./render/shell.ts";
import { emptyState } from "./render/components.ts";
import { h } from "./h.ts";
import es from "../locales/es.json";
import en from "../locales/en.json";
import pt from "../locales/pt.json";

const MESSAGES: Record<Lang, Messages> = { es, en, pt };

type Family = "home" | "explore" | "festival" | "saved" | "settings" | "about" | "notfound";

function family(route: Route): Family {
  if (route.name === "country" || route.name === "region") return "home";
  return route.name;
}

interface Elements {
  masthead: HTMLElement;
  main: HTMLElement;
  footer: HTMLElement;
  bottomnav: HTMLElement;
  notices: HTMLElement;
  live: HTMLElement;
  skip: HTMLAnchorElement;
}

function depthOf(state: unknown): number {
  const depth = typeof state === "object" && state !== null ? (state as { depth?: unknown }).depth : undefined;
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

const STICKY_CHROME = [".masthead", ".summary", ".actionbar", ".bottomnav"];
const CLEARANCE = 8;

/**
 * WCAG 2.2 SC 2.4.11: browsers scroll a focused control into the viewport, not clear of sticky
 * bars (scroll-padding covers jumps, not every engine's focus scroll). After the browser's own
 * scroll, a control still painted under a bar is scrolled out from under it. Only Tab-reachable
 * controls: <main tabindex=-1> (skip link, a tap on text) and the focused h1 span far more than a
 * bar, and moving them would throw the page to the footer (UI-1).
 */
function keepClearOfChrome(el: HTMLElement): void {
  if (el.tabIndex < 0) return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    for (const sel of STICKY_CHROME) {
      const bar = document.querySelector<HTMLElement>(sel);
      if (!bar || bar.contains(el)) continue;
      const style = getComputedStyle(bar);
      if (style.display === "none" || (style.position !== "fixed" && style.position !== "sticky")) continue;
      const b = bar.getBoundingClientRect();
      if (r.height >= window.innerHeight - b.height) return; // no scroll can clear it
      const top = Math.max(r.top, b.top);
      const bottom = Math.min(r.bottom, b.bottom);
      const left = Math.max(r.left, b.left);
      const right = Math.min(r.right, b.right);
      if (bottom - top <= 1 || right - left <= 1) continue;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit || !bar.contains(hit)) continue; // the control is painted above the bar (skip link)
      const below = b.top > window.innerHeight / 2;
      window.scrollBy({ top: below ? r.bottom - b.top + CLEARANCE : -(b.bottom - r.top + CLEARANCE), behavior: "instant" });
      return;
    }
  });
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

export function boot(): void {
  const els: Elements = {
    masthead: requireEl("masthead"),
    main: requireEl("main"),
    footer: requireEl("footer"),
    bottomnav: requireEl("bottomnav"),
    notices: requireEl("notices"),
    live: requireEl("live"),
    skip: requireEl<HTMLAnchorElement>("skip"),
  };

  // Read on every check, not once: a traveller's open app can cross into another zone.
  const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const override = todayOverride(location.search);
  // Re-read on wake and every minute: an installed app left open overnight must not keep yesterday.
  let today: ISO = override ?? todayIn(deviceZone());
  const store: Store = createStore();
  let i18n: I18n = createI18n(MESSAGES, store.get("lang") ?? detectLang(navigator.languages));
  const siteUrl = `${location.origin}${import.meta.env.BASE_URL}`;
  const repo = typeof import.meta.env.VITE_REPO === "string" && /^[\w.-]+\/[\w.-]+$/.test(import.meta.env.VITE_REPO) ? import.meta.env.VITE_REPO : DEFAULT_REPO;

  let route: Route = parseHash(location.hash);
  let geo: GeoState = { status: "off" };
  // Explorar opens where the user left it; on first use, on the country Inicio is showing.
  let lastExplore: string | null = null;
  const exploreTarget = (): string => {
    if (lastExplore) return lastExplore;
    const scope = store.get("scope");
    return serializeRoute({ name: "explore", filters: { ...EMPTY_FILTERS, countries: scope?.kind === "country" ? [scope.code] : [] } });
  };
  // In-app history depth, kept in history.state so Back, Forward and reloads know whether the
  // previous entry is ours (masthead «Volver» then goes back) or the page was a deep link.
  let inAppDepth = depthOf(history.state);
  let pendingFocus: "title" | string | null = "title";
  const scrollByHash = new Map<string, number>();
  let navKind: "push" | "replace" | null = null;

  void loadIndex().catch(() => {
    /* Screens show their own error state with a retry. */
  });

  const announce = (text: string): void => {
    els.live.textContent = "";
    window.setTimeout(() => {
      els.live.textContent = text;
    }, 60);
  };

  const applyFocus = (): void => {
    if (!pendingFocus) return;
    if (pendingFocus === "title") {
      const title = els.main.querySelector<HTMLElement>(".screen-title");
      if (title) {
        title.focus({ preventScroll: true });
        pendingFocus = null;
      }
      return;
    }
    const target = els.main.querySelector<HTMLElement>(`[data-key="${CSS.escape(pendingFocus)}"]`) ?? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(pendingFocus)}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      pendingFocus = null;
    }
  };

  const scrollKeys = (): Map<string, number> => {
    const out = new Map<string, number>();
    els.main.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => out.set(el.dataset.scrollKey ?? "", el.scrollLeft));
    return out;
  };

  const restoreScrollKeys = (saved: Map<string, number>): void => {
    els.main.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
      const left = saved.get(el.dataset.scrollKey ?? "");
      if (left !== undefined) el.scrollLeft = left;
    });
  };

  let pendingScroll: number | null = null;

  const ctxFor = (): Ctx => ({
    t: i18n.t,
    lang: i18n.lang,
    today,
    weekStart: store.get("weekStart") ?? localeWeekStart(navigator.language || i18n.lang),
    store,
    siteUrl,
    repo,
    route,
    href: (r) => serializeRoute(r),
    navigate: (r, opts) => {
      const hash = serializeRoute(r);
      if (hash === (location.hash || "#/")) {
        render(false);
        return;
      }
      if (opts?.replace) {
        navKind = "replace";
        history.replaceState({ depth: inAppDepth }, "", `${location.pathname}${location.search}${hash}`);
        onHashChange();
        return;
      }
      navKind = "push";
      location.hash = hash;
    },
    refresh: () => render(false),
    geo: () => geo,
    requestGeo: () => {
      if (!("geolocation" in navigator)) {
        geo = { status: "unavailable" };
        render(false);
        return;
      }
      geo = { status: "asking" };
      render(false);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords: Coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          geo = { status: "on", coords };
          announce(i18n.t("near.on"));
          render(false);
        },
        (err) => {
          geo = { status: err.code === err.PERMISSION_DENIED ? "denied" : "unavailable" };
          render(false);
        },
        { enableHighAccuracy: false, maximumAge: 600_000, timeout: 15_000 },
      );
    },
    forgetGeo: () => {
      geo = { status: "off" };
      announce(i18n.t("near.forgotten"));
      render(false);
    },
    title: (text) => {
      document.title = i18n.t("app.docTitle", { page: text });
    },
    announce,
    settled: () => {
      applyFocus();
      if (pendingScroll !== null) {
        window.scrollTo({ top: pendingScroll });
        pendingScroll = null;
      }
    },
  });

  const screenFor = (ctx: Ctx): HTMLElement => {
    switch (route.name) {
      case "home": {
        const pref = store.get("scope");
        const scope = pref?.kind === "country" ? { kind: "country" as const, code: pref.code } : pref?.kind === "region" ? { kind: "region" as const, region: pref.region } : { kind: "world" as const };
        return renderHome(scope, route.query, ctx);
      }
      case "country":
        return renderHome({ kind: "country", code: route.code }, route.query, ctx);
      case "region":
        return renderHome({ kind: "region", region: route.region }, route.query, ctx);
      case "explore":
        return renderExplore(route.filters, ctx);
      case "festival":
        return renderFestival(route.slug, ctx);
      case "saved":
        return renderSaved(ctx);
      case "settings":
        return renderSettings(ctx);
      case "about":
        return renderAbout(ctx);
      case "notfound":
        ctx.title(ctx.t("notfound.title"));
        return h(
          "div",
          { class: "screen" },
          h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("notfound.title")),
          emptyState(ctx.t("notfound.body"), null, [{ label: ctx.t("nav.home"), href: "#/", primary: true }]),
        );
    }
  };

  // The ?today= hook is never silent: a shared link with a fake date says so on every screen.
  const renderOffline = (): void => {
    const ctx = ctxFor();
    const notices = [override ? todayOverrideNotice(override, `${location.pathname}${location.hash}`, ctx) : null, navigator.onLine ? null : offlineNotice(ctx)];
    els.notices.replaceChildren(...notices.filter((n): n is HTMLElement => n !== null));
  };

  function render(newView: boolean): void {
    const ctx = ctxFor();
    document.documentElement.lang = i18n.lang;
    if (!newView) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-key]") : null;
      pendingFocus = active?.dataset.key ?? null;
    }
    const savedScroll = newView ? new Map<string, number>() : scrollKeys();
    const keepY = window.scrollY;

    const onBack = route.name === "festival" ? () => (inAppDepth > 0 ? history.back() : ctx.navigate(parseHash(exploreTarget()))) : null;
    const screen = screenFor(ctx); // first: Inicio records the scope the nav links depend on
    const targets = { explore: exploreTarget() };
    renderMasthead(els.masthead, ctx, targets, onBack);
    renderBottomNav(els.bottomnav, ctx, targets);
    renderFooter(els.footer, ctx);
    renderSkipLink(els.skip, ctx, els.main);
    renderOffline();

    els.main.replaceChildren(screen);
    document.body.dataset.screen = route.name;
    restoreScrollKeys(savedScroll);
    if (!newView) window.scrollTo({ top: keepY });
    applyFocus();
  }

  function onHashChange(): void {
    const next = parseHash(location.hash);
    const sameFamily = family(next) === family(route) && next.name !== "festival";
    const kind = navKind;
    navKind = null;
    const fromApp = kind !== null;
    route = next;
    if (route.name === "explore") lastExplore = location.hash || "#/explorar";
    closeSheet();
    if (kind === "push") {
      inAppDepth++;
      history.replaceState({ depth: inAppDepth }, "");
    } else if (kind === null) inAppDepth = depthOf(history.state); // Back, Forward or a typed URL

    if (sameFamily) {
      render(false);
      return;
    }
    pendingFocus = "title";
    const restore = fromApp ? null : (scrollByHash.get(location.hash) ?? null);
    render(true);
    if (restore !== null) {
      pendingScroll = restore;
      window.scrollTo({ top: restore });
    } else window.scrollTo({ top: 0 });
  }

  let currentHash = location.hash;
  window.addEventListener("scroll", () => scrollByHash.set(currentHash, window.scrollY), { passive: true });
  window.addEventListener("hashchange", () => {
    currentHash = location.hash;
    onHashChange();
  });
  window.addEventListener("online", renderOffline);
  window.addEventListener("offline", renderOffline);

  // Plain in-app anchors (festival rows, nav) are pushes too; a same-hash click fires no hashchange.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#/"]') : null;
    if (link && !link.target && link.getAttribute("href") !== (location.hash || "#/")) navKind = "push";
  });

  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) keepClearOfChrome(event.target);
  });

  if (!override) {
    const refreshToday = (): void => {
      const now = todayIn(deviceZone());
      if (now === today) return;
      today = now;
      const y = window.scrollY;
      render(false);
      // A new day is a new resource key: async screens show a skeleton, so restore once settled.
      if (els.main.querySelector("[aria-busy='true']")) pendingScroll = y;
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshToday();
    });
    window.addEventListener("focus", refreshToday);
    window.setInterval(refreshToday, 60_000);
  }

  store.subscribe((key) => {
    if (key === "lang") {
      const lang = store.get("lang") ?? detectLang(navigator.languages);
      if (lang !== i18n.lang) {
        i18n = createI18n(MESSAGES, lang);
        render(false);
        announce(i18n.t("settings.languageChanged"));
      }
    } else if (key === "weekStart") {
      render(false);
    } else if (key === "saved") {
      renderBottomNav(els.bottomnav, ctxFor(), { explore: exploreTarget() });
    }
  });

  if (route.name === "explore") lastExplore = location.hash;
  pendingFocus = null;
  render(true);
}
