// Inicio (RF-01, RF-05, RF-13): «Lo próximo» for the chosen scope, then the rolling 12 months.
// #/ shows the last scope used; #/pais/<cc> and #/region/<id> pin it (shareable, RF-12).
import { upcoming, type FestivalEntry, type Scope } from "../festivals.ts";
import { h } from "../h.ts";
import { countryName } from "../ics.ts";
import type { HomeQuery, Route } from "../router.ts";
import {
  asyncView,
  confidenceMark,
  countdownBlock,
  countdownText,
  emptyState,
  festivalName,
  moonNote,
  notice,
  occurrenceDates,
  placeLine,
  sectionHeading,
  statusBadge,
  typeTag,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { percent, relativeDays, shortDate } from "./format.ts";
import { icon } from "./icons.ts";
import { countdown, countryInfo, isStale, loadScope, PARTIAL_SHARE, resource, timelineHits, type IndexCountry, type ScopeData } from "./model.ts";
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
    h("span", { class: "poster__band", "aria-hidden": "true" }),
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
        occ ? h("p", { class: "marks" }, statusBadge(occ.status, ctx.t), confidenceMark(occ.confidence, ctx.t)) : null,
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
      h("p", { class: "marks" }, typeTag(f.type, ctx.t), occ ? statusBadge(occ.status, ctx.t) : null, occ ? confidenceMark(occ.confidence, ctx.t) : null),
    ),
    h("p", { class: "next-row__count num" }, countdownText(countdown(occ, ctx.today), ctx.t)),
  );
}

function freshness(countries: readonly IndexCountry[], scope: Scope, ctx: Ctx): HTMLElement | null {
  if (scope.kind !== "country") return null;
  const info = countries.find((c) => c.code === scope.code);
  if (!info?.last_verified) return null;
  return h(
    "p",
    { class: "freshness" },
    icon("check"),
    ctx.t("fresh.verified", { when: relativeDays(info.last_verified, ctx.today, ctx.lang) }),
    " ",
    h("a", { href: ctx.href({ name: "about" }), class: "link" }, ctx.t("fresh.how")),
  );
}

function coverageNote(info: IndexCountry | undefined, ctx: Ctx): HTMLElement | null {
  if (!info || typeof info.share_a !== "number" || info.share_a >= PARTIAL_SHARE) return null;
  return h("p", { class: "freshness freshness--partial" }, icon("alert"), ctx.t("fresh.partial", { share: percent(info.share_a, ctx.lang) }));
}

function staleNotice(info: IndexCountry | undefined, ctx: Ctx): HTMLElement | null {
  if (!info || !isStale(info.last_verified, ctx.today)) return null;
  return notice(
    "warn",
    "alert",
    h(
      "p",
      null,
      info.last_verified
        ? ctx.t("fresh.stale", { country: countryName(info.code, ctx.lang), date: shortDate(info.last_verified, ctx.lang), days: relativeDays(info.last_verified, ctx.today, ctx.lang) })
        : ctx.t("fresh.never", { country: countryName(info.code, ctx.lang) }),
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

function unpublished(code: string, data: ScopeData, ctx: Ctx): HTMLElement {
  return emptyState(ctx.t("home.unpublishedTitle", { country: countryName(code, ctx.lang) }), ctx.t("home.unpublishedBody"), [
    ...data.index.countries.slice(0, 3).map((c, i) => ({
      label: ctx.t("home.seeCountry", { country: countryName(c.code, ctx.lang) }),
      href: ctx.href({ name: "country", code: c.code, query: { tier2: false } }),
      primary: i === 0,
    })),
    { label: ctx.t("home.seeWorld"), href: ctx.href({ name: "home", query: { tier2: false } }) },
  ]);
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
    first
      ? hero(first, ctx)
      : emptyState(ctx.t("home.emptyTitle"), ctx.t("home.emptyBody"), [
          ...(query.tier2 ? [] : [{ label: ctx.t("filters.tier2On"), onClick: () => ctx.navigate(routeFor(scope, { tier2: true })), primary: true }]),
          { label: ctx.t("home.seeWorld"), href: ctx.href({ name: "home", query: { tier2: true } }) },
        ]),
    rest.length ? h("ol", { class: "next-list", "aria-label": ctx.t("home.alsoSoon") }, rest.map((e) => nextRow(e, ctx))) : null,
    freshness(data.index.countries, scope, ctx),
    coverageNote(info, ctx),
    h(
      "section",
      { class: "section", "aria-labelledby": "tl-title" },
      h("div", { class: "section__head" }, sectionHeading(ctx.t("timeline.title"), "tl-title"), tier2Switch(scope, query, ctx)),
      hits.length
        ? [legend(types, ctx), timeline(hits, ctx)]
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
