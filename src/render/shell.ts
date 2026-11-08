// App chrome: masthead (wordmark, back on detail screens, top nav on desktop), bottom nav on
// phones (thumb zone), footer and the notices strip (offline).
import type { ISO } from "../dates.ts";
import { h } from "../h.ts";
import type { Route } from "../router.ts";
import type { Ctx } from "./context.ts";
import { shortDate } from "./format.ts";
import { brandMark, icon, type IconName } from "./icons.ts";

type NavId = "home" | "explore" | "saved" | "settings";

const NAV: readonly { id: NavId; icon: IconName; key: string }[] = [
  { id: "home", icon: "home", key: "nav.home" },
  { id: "explore", icon: "explore", key: "nav.explore" },
  { id: "saved", icon: "saved", key: "nav.saved" },
  { id: "settings", icon: "settings", key: "nav.settings" },
];

export function activeNav(route: Route): NavId | null {
  switch (route.name) {
    case "home":
    case "country":
    case "region":
      return "home";
    case "explore":
      return "explore";
    case "saved":
      return "saved";
    case "settings":
    case "about":
      return "settings";
    default:
      return null;
  }
}

export interface NavTargets {
  explore: string;
}

function navList(ctx: Ctx, targets: NavTargets, place: "top" | "bottom"): HTMLElement {
  const active = activeNav(ctx.route);
  const hrefs: Record<NavId, string> = {
    home: ctx.href({ name: "home", query: { tier2: false } }),
    explore: targets.explore,
    saved: ctx.href({ name: "saved" }),
    settings: ctx.href({ name: "settings" }),
  };
  const savedCount = ctx.store.get("saved").length;
  return h(
    "ul",
    null,
    NAV.map((item) =>
      h(
        "li",
        null,
        h(
          "a",
          { href: hrefs[item.id], class: "navlink", "aria-current": active === item.id ? "page" : null, "data-key": `nav-${place}-${item.id}` },
          icon(item.icon, item.id === "saved" && active === "saved"),
          h("span", { class: "navlink__label" }, ctx.t(item.key), item.id === "saved" && savedCount > 0 ? h("span", { class: "sr-only" }, `(${ctx.t("saved.count", { count: savedCount })})`) : null),
          item.id === "saved" && savedCount > 0 ? h("span", { class: "navlink__badge num", "aria-hidden": "true" }, String(savedCount)) : null,
        ),
      ),
    ),
  );
}

export function renderMasthead(el: Element, ctx: Ctx, targets: NavTargets, onBack: (() => void) | null): void {
  // Back comes first, where thumbs and habit look for it; DOM order is the visual and tab order.
  const inner = h(
    "div",
    { class: `masthead__inner${onBack ? " masthead__inner--back" : ""}` },
    onBack
      ? h("button", { type: "button", class: "btn btn--ghost masthead__back", "data-key": "back", onclick: onBack }, icon("back"), ctx.t("nav.back"))
      : null,
    h("a", { href: ctx.href({ name: "home", query: { tier2: false } }), class: "wordmark", "data-key": "wordmark" }, brandMark(), h("span", null, ctx.t("app.name"))),
    h("nav", { class: "topnav", "aria-label": ctx.t("nav.label") }, navList(ctx, targets, "top")),
  );
  el.replaceChildren(inner);
}

export function renderBottomNav(el: Element, ctx: Ctx, targets: NavTargets): void {
  el.setAttribute("aria-label", ctx.t("nav.label"));
  el.replaceChildren(navList(ctx, targets, "bottom"));
}

export function renderFooter(el: Element, ctx: Ctx): void {
  el.replaceChildren(
    h("p", { class: "footer__line" }, ctx.t("footer.privacy")),
    h("p", { class: "footer__line" }, ctx.t("footer.ai")),
    h("a", { href: ctx.href({ name: "about" }), class: "link", "data-key": "footer-about" }, ctx.t("about.title")),
  );
}

export function renderSkipLink(el: HTMLAnchorElement, ctx: Ctx, main: HTMLElement): void {
  el.textContent = ctx.t("nav.skip");
  el.onclick = (event) => {
    event.preventDefault();
    main.focus();
  };
}

/** SEC-13: the ?today= test hook changes every countdown, so it is always visible, with a way out. */
export function todayOverrideNotice(date: ISO, realHref: string, ctx: Ctx): HTMLElement {
  return h(
    "div",
    { class: "notice notice--info notice--today", "data-testid": "today-override" },
    icon("calendar"),
    h("div", { class: "notice__body" }, h("p", null, ctx.t("today.override", { date: shortDate(date, ctx.lang) }), " ", h("a", { href: realHref, class: "link" }, ctx.t("today.useReal")))),
  );
}

export function offlineNotice(ctx: Ctx): HTMLElement {
  return h("div", { class: "notice notice--offline", role: "status" }, icon("offline"), h("div", { class: "notice__body" }, h("p", null, ctx.t("offline.notice"))));
}
