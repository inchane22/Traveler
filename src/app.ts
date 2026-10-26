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
import { offlineNotice, renderBottomNav, renderFooter, renderMasthead, renderSkipLink } from "./render/shell.ts";
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

  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today: ISO = todayOverride(location.search) ?? todayIn(deviceZone);
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
  let inAppDepth = 0;
  let pendingFocus: "title" | string | null = "title";
  const scrollByHash = new Map<string, number>();
  let navigatingInApp = false;

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
      navigatingInApp = true;
      if (opts?.replace) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
      else location.hash = hash;
      if (opts?.replace) onHashChange();
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
        const scope = pref?.kind === "country" ? { kind: "country" as const, code: pref.code } : pref?.kind === "region" ? { kind: "region" as const, region: pref.region as "sudamerica" } : { kind: "world" as const };
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

  const renderOffline = (): void => {
    els.notices.replaceChildren(...(navigator.onLine ? [] : [offlineNotice(ctxFor())]));
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
    const fromApp = navigatingInApp;
    navigatingInApp = false;
    route = next;
    if (route.name === "explore") lastExplore = location.hash || "#/explorar";
    closeSheet();
    if (fromApp) inAppDepth++;
    else inAppDepth = Math.max(0, inAppDepth - 1);

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
