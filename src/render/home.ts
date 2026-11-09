// Inicio (RF-01, RF-05, RF-13): «Lo próximo» for the chosen scope, then the rolling 12 months.
// #/ shows the last scope used; #/pais/<cc> and #/region/<id> pin it (shareable, RF-12).
import { upcoming, type FestivalEntry, type Scope } from "../festivals.ts";
import { h } from "../h.ts";
import { countryName } from "../ics.ts";
import type { HomeQuery, Route } from "../router.ts";
import {
  asyncView,
  buildAction,
  countdownBlock,
  countdownText,
  emptyState,
  festivalName,
  liveNote,
  moonNote,
  notice,
  occurrenceDates,
  placeLine,
  posterBand,
  sectionHeading,
  staleNotice,
  suggestAction,
  trustMark,
  typeTag,
  type EmptyAction,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { longDate, percent, relativeDays } from "./format.ts";
import { icon } from "./icons.ts";
import { marksButton } from "./marks.ts";
import { resource } from "../resource.ts";
import { countdown, countryInfo, loadScope, PARTIAL_SHARE, requestFor, timelineHits, type IndexCountry, type ScopeData } from "./model.ts";
import { openScopeSheet } from "./scope.ts";
import { subscribeBlock } from "./subscribe.ts";
import { legend, timeline } from "./timeline.ts";

export function scopeLabel(scope: Scope, ctx: Ctx): string {
  if (scope.kind === "world") return ctx.t("scope.world");
  if (scope.kind === "region") return ctx.t(`region.${scope.region}`);
  return countryName(scope.code, ctx.lang);
}

function routeFor(scope: Scope, query: HomeQuery): Route {
  if (scope.kind === "country") return { name: "country", code: scope.code, query };
  if (scope.kind === "region") return { name: "region", region: scope.region as Extract<Route, { name: "region" }>["region"], query };
  return { name: "home", query };
}

function hero(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const f = entry.festival;
  const occ = entry.occurrence;
  const cancelled = occ?.status === "cancelada";
  return h(
    "article",
    { class: `poster type--${f.type}${cancelled ? " is-cancelled" : ""}`, "data-testid": "next-festival" },
    posterBand(occ),
    h("div", { class: "poster__top" }, typeTag(f.type, ctx.t), h("span", { class: "poster__kicker" }, ctx.t("home.next"))),
    h(
      "h2",
      { class: "poster__name display" },
      h("a", { href: ctx.href({ name: "festival", slug: f.slug }), class: "stretched", "data-key": `hero-${f.slug}` }, festivalName(f, ctx.lang)),
    ),
    h("p", { class: "poster__place" }, placeLine(entry, ctx.lang)),
    h(
      "div",
      { class: "poster__foot" },
      h(
        "div",
        { class: "poster__when" },
        h("p", { class: "poster__dates num" }, occurrenceDates(occ, ctx.lang, ctx.t)),
        occ ? h("p", { class: "marks" }, trustMark(occ, ctx.t)) : null,
        moonNote(occ, ctx.t),
      ),
      countdownBlock(occ, ctx),
    ),
  );
}

function nextRow(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const f = entry.festival;
  const occ = entry.occurrence;
  return h(
    "li",
    { class: `next-row type--${f.type}` },
    h("span", { class: "next-row__band", "aria-hidden": "true" }),
    h(
      "div",
      { class: "next-row__main" },
      h(
        "h3",
        { class: "next-row__name display" },
        h("a", { href: ctx.href({ name: "festival", slug: f.slug }), class: "stretched", "data-key": `next-${f.slug}` }, festivalName(f, ctx.lang)),
      ),
      h("p", { class: "next-row__meta" }, h("span", { class: "num next-row__dates" }, occurrenceDates(occ, ctx.lang, ctx.t)), h("span", { class: "next-row__place" }, placeLine(entry, ctx.lang))),
      h("p", { class: "marks" }, typeTag(f.type, ctx.t), occ ? trustMark(occ, ctx.t) : null),
    ),
    h("p", { class: "next-row__count num" }, countdownText(countdown(occ, ctx.today), ctx.t)),
  );
}

/** One trust line: when the country was verified and, under 60 % A sources, that coverage is partial (RF-13, R2). */
function freshness(info: IndexCountry | undefined, ctx: Ctx): HTMLElement | null {
  if (!info) return null;
  const partial = typeof info.share_a === "number" && info.share_a < PARTIAL_SHARE;
  if (!info.last_verified && !partial) return null;
  return h(
    "p",
    { class: `freshness${partial ? " freshness--partial" : ""}` },
    icon(partial ? "alert" : "check"),
    h(
      "span",
      null,
      info.last_verified ? ctx.t("fresh.verified", { when: relativeDays(info.last_verified, ctx.today, ctx.lang) }) : null,
      info.last_verified && partial ? " " : null,
      partial ? h("strong", { class: "freshness__partial" }, ctx.t("fresh.partial", { share: percent(info.share_a, ctx.lang) })) : null,
      " ",
      h("a", { href: ctx.href({ name: "about" }), class: "link" }, ctx.t("fresh.how")),
    ),
  );
}

function tier2Switch(scope: Scope, query: HomeQuery, ctx: Ctx): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      role: "switch",
      class: "switch",
      "aria-checked": String(query.tier2),
      "data-key": "home-tier2",
      onclick: () => ctx.navigate(routeFor(scope, { tier2: !query.tier2 })),
    },
    h("span", { class: "switch__track", "aria-hidden": "true" }, h("span", { class: "switch__thumb" })),
    h("span", { class: "switch__label" }, ctx.t("filters.tier2")),
  );
}

/**
 * A country with no data: offer to build it, or say where its build stands (data/state/requests.json
 * through the index): being built, trying again on a date, or given up (ask again).
 */
function unpublished(code: string, data: ScopeData, ctx: Ctx): HTMLElement {
  const country = countryName(code, ctx.lang);
  const request = requestFor(data.index, code);
  const elsewhere = [
    ...data.index.countries.slice(0, 3).map((c) => ({
      label: ctx.t("home.seeCountry", { country: countryName(c.code, ctx.lang) }),
      href: ctx.href({ name: "country", code: c.code, query: { tier2: false } }),
    })),
    { label: ctx.t("home.seeWorld"), href: ctx.href({ name: "home", query: { tier2: false } }) },
  ];
  const view = (title: string, body: string, first: EmptyAction[]) =>
    h("div", { "data-testid": "unbuilt", "data-build": request?.status ?? "none" }, emptyState(title, body, [...first, ...elsewhere]));
  switch (request?.status) {
    case "queued":
      return view(ctx.t("build.queuedTitle", { country }), ctx.t("build.queuedBody"), []);
    case "retry":
      return view(ctx.t("build.retryTitle", { country }), ctx.t("build.retryBody", { date: request.retry_after ? longDate(request.retry_after, ctx.lang) : "—" }), []);
    case "gave_up":
      return view(ctx.t("build.gaveUpTitle", { country }), ctx.t("build.gaveUpBody"), [buildAction(ctx, code, ctx.t("build.askAgain"))]);
    default:
      return view(ctx.t("home.unpublishedTitle", { country }), ctx.t("home.unpublishedBody"), [buildAction(ctx, code), suggestAction(ctx, code)]);
  }
}

function content(scope: Scope, query: HomeQuery, data: ScopeData, ctx: Ctx): HTMLElement[] {
  const info = scope.kind === "country" ? countryInfo(data.index, scope.code) : undefined;
  if (scope.kind === "country" && !info) return [unpublished(scope.code, data, ctx)];

  const next = upcoming(data.entries, ctx.today, 3);
  const hits = timelineHits(data.entries, ctx.today);
  const types = [...new Set(hits.map((hit) => hit.entry.festival.type))];
  const draft = data.countries.some((c) => c.status === "borrador") ? notice("draft", "alert", h("p", null, ctx.t("draft.banner"))) : null;
  const [first, ...rest] = next;

  const out: (HTMLElement | null)[] = [
    staleNotice(info, ctx),
    draft,
    liveNote(data.index, scope, ctx),
    first
      ? hero(first, ctx)
      : emptyState(ctx.t("home.emptyTitle"), ctx.t("home.emptyBody"), [
          ...(query.tier2 ? [] : [{ label: ctx.t("filters.tier2On"), onClick: () => ctx.navigate(routeFor(scope, { tier2: true })), primary: true }]),
          { label: ctx.t("home.seeWorld"), href: ctx.href({ name: "home", query: { tier2: true } }) },
          suggestAction(ctx, scope.kind === "country" ? scope.code : undefined),
        ]),
    rest.length ? h("ol", { class: "next-list", "aria-label": ctx.t("home.alsoSoon") }, rest.map((e) => nextRow(e, ctx))) : null,
    freshness(info, ctx),
    h(
      "section",
      { class: "section", "aria-labelledby": "tl-title" },
      h("div", { class: "section__head" }, sectionHeading(ctx.t("timeline.title"), "tl-title"), tier2Switch(scope, query, ctx)),
      hits.length
        ? [legend(types, ctx), h("p", { class: "legend__help" }, marksButton(ctx, "home-marks")), timeline(hits, ctx)]
        : emptyState(ctx.t("timeline.empty"), null, [{ label: ctx.t("nav.explore"), href: ctx.href({ name: "explore", filters: { countries: [], months: [], types: [], tier2: true, sort: "date" } }) }]),
    ),
    scope.kind === "country" ? subscribeBlock(scope.code, ctx) : null,
  ];
  return out.filter((x): x is HTMLElement => x !== null);
}

export function renderHome(scope: Scope, query: HomeQuery, ctx: Ctx): HTMLElement {
  if (scope.kind === "country") ctx.store.pushRecent(scope.code);
  ctx.store.set("scope", scope.kind === "country" ? { kind: "country", code: scope.code } : scope.kind === "region" ? { kind: "region", region: scope.region } : { kind: "world" });

  const label = scopeLabel(scope, ctx);
  ctx.title(ctx.t("home.docTitle", { scope: label }));
  const scopeButton = h(
    "button",
    { type: "button", class: "scope-btn", "data-key": "scope-btn", "aria-haspopup": "dialog", onclick: () => openScopeSheet(scope, ctx) },
    h("span", { class: "scope-btn__label" }, label),
    h("span", { class: "sr-only" }, ` ${ctx.t("scope.change")}`),
    icon("chevronDown"),
  );
  const title = h("h1", { class: "screen-title home-title display", tabindex: "-1" }, h("span", { class: "home-title__prefix" }, ctx.t("home.titleIn")), " ", scopeButton);

  const res = resource(`scope|${JSON.stringify(scope)}|${query.tier2}|${ctx.today}`, () => loadScope(scope, query.tier2, ctx.today));
  return h("div", { class: "screen screen--home" }, title, asyncView(res, "home", ctx, (data) => content(scope, query, data, ctx)));
}
