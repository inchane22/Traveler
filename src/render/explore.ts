// Explorar (RF-03, RF-04, RF-14): month-grouped list with filter chips. Every chip shows how many
// festivals it would give; all state lives in the hash so links share and Back restores filters.
import { addDays, effectiveStart, type ISO } from "../dates.ts";
import { applyFilters, isVisible, type FestivalEntry, type FilterHit } from "../festivals.ts";
import { h, type Child } from "../h.ts";
import { countryName } from "../ics.ts";
import { EMPTY_FILTERS, FESTIVAL_TYPES, hasActiveFilters, type ExploreState } from "../router.ts";
import type { FestivalType } from "../schema.ts";
import {
  asyncView,
  confidenceMark,
  dateBand,
  emptyState,
  festivalName,
  occurrenceDates,
  placeLine,
  saveButton,
  statusBadge,
  typeTag,
  type EmptyAction,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { dayNumber, monthLabel, monthShort } from "./format.ts";
import { entriesFor, filtersFrom, haversineKm, loadCountry, loadIndex, resource, rollingMonths, type PublicIndex } from "./model.ts";
import { icon } from "./icons.ts";

interface ExploreData {
  index: PublicIndex;
  all: FestivalEntry[];
}

async function loadExplore(today: ISO): Promise<ExploreData> {
  const index = await loadIndex();
  const countries = await Promise.all(index.countries.map((c) => loadCountry(c.code)));
  return { index, all: countries.flatMap((c) => entriesFor(c, today)) };
}

/** Countries chosen → each country's own ranking rules; none → the world view (tier 1 only). */
function visibleFor(all: readonly FestivalEntry[], countries: readonly string[], tier2: boolean): FestivalEntry[] {
  if (!countries.length) return all.filter((e) => isVisible(e, { kind: "world" }, tier2));
  return all.filter((e) => countries.includes(e.country) && isVisible(e, { kind: "country", code: e.country }, tier2));
}

function run(all: readonly FestivalEntry[], f: ExploreState, today: ISO): FilterHit[] {
  return applyFilters(visibleFor(all, f.countries, f.tier2), filtersFrom(f), today);
}

const toggle = <T>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function chip(ctx: Ctx, label: Child, count: number, pressed: boolean, key: string, onClick: () => void, extra?: Child): HTMLElement {
  return h(
    "button",
    { type: "button", class: `chip${count === 0 && !pressed ? " chip--zero" : ""}`, "aria-pressed": String(pressed), "data-key": key, onclick: onClick },
    extra ?? null,
    h("span", { class: "chip__label" }, label, h("span", { class: "sr-only" }, `(${ctx.t("explore.count", { count })})`)),
    h("span", { class: "chip__count num", "aria-hidden": "true" }, String(count)),
  );
}

function chipRow(label: string, id: string, chips: HTMLElement[]): HTMLElement {
  return h(
    "div",
    { class: "chip-group", role: "group", "aria-labelledby": id },
    h("span", { class: "chip-group__label", id }, label),
    h("div", { class: "chip-row", "data-key": `row-${id}`, "data-scroll-key": `row-${id}` }, chips),
  );
}

function row(hit: FilterHit, ctx: Ctx, distanceKm: number | null): HTMLElement {
  const e = hit.entry;
  const f = e.festival;
  const occ = hit.occurrence;
  const start = effectiveStart(occ);
  const cancelled = occ.status === "cancelada";
  return h(
    "li",
    { class: `fest-row type--${f.type}${cancelled ? " is-cancelled" : ""}`, "data-slug": f.slug },
    h(
      "div",
      { class: "stub", "aria-hidden": "true" },
      h("span", { class: "stub__day num" }, occ.start ? dayNumber(start) : "≈"),
      h("span", { class: "stub__month" }, monthShort(start, ctx.lang)),
      dateBand(occ, f.type),
    ),
    h(
      "div",
      { class: "fest-row__main" },
      h("h3", { class: "fest-row__name display" }, h("a", { href: ctx.href({ name: "festival", slug: f.slug }), class: "stretched", "data-key": `row-${f.slug}` }, festivalName(f, ctx.lang))),
      h("p", { class: "fest-row__when" }, h("span", { class: "num" }, occurrenceDates(occ, ctx.lang, ctx.t)), h("span", { class: "fest-row__place" }, placeLine(e, ctx.lang))),
      h(
        "p",
        { class: "marks" },
        typeTag(f.type, ctx.t),
        statusBadge(occ.status, ctx.t),
        confidenceMark(occ.confidence, ctx.t),
        hit.possible ? h("span", { class: "tag tag--possible" }, ctx.t("explore.possible")) : null,
        distanceKm !== null ? h("span", { class: "tag num" }, icon("pin"), ctx.t("explore.distance", { km: Math.round(distanceKm) })) : null,
      ),
    ),
    saveButton(e, ctx),
  );
}

function grouped(hits: readonly FilterHit[], ctx: Ctx): HTMLElement[] {
  const groups = new Map<string, FilterHit[]>();
  for (const hit of hits) {
    const key = effectiveStart(hit.occurrence).slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  return [...groups].map(([month, list]) => {
    const id = `m-${month}`;
    return h(
      "section",
      { class: "month", "aria-labelledby": id },
      h("h2", { class: "month__title display", id }, monthLabel(`${month}-01`, ctx.lang), h("span", { class: "month__count num" }, ctx.t("explore.count", { count: list.length }))),
      h("ul", { class: "fest-list" }, list.map((hit) => row(hit, ctx, null))),
    );
  });
}

function nearList(hits: readonly FilterHit[], ctx: Ctx): HTMLElement {
  const geo = ctx.geo();
  if (geo.status !== "on") {
    return emptyState(ctx.t("near.needTitle"), ctx.t("near.needBody"), [{ label: ctx.t("near.enable"), primary: true, onClick: () => ctx.requestGeo() }]);
  }
  const withDist = hits
    .map((hit) => ({ hit, km: haversineKm(geo.coords, hit.entry.festival.coords) }))
    .sort((a, b) => a.km - b.km);
  return h("ul", { class: "fest-list fest-list--near" }, withDist.map(({ hit, km }) => row(hit, ctx, km)));
}

function emptyActions(f: ExploreState, data: ExploreData, ctx: Ctx, go: (next: ExploreState) => void): EmptyAction[] {
  const actions: EmptyAction[] = [];
  if (f.months.length) {
    const neighbors = new Set<string>();
    for (const m of f.months) {
      neighbors.add(addDays(`${m}-01`, -1).slice(0, 7));
      neighbors.add(addDays(`${m}-28`, 7).slice(0, 7));
    }
    const months = [...new Set([...f.months, ...neighbors])].sort();
    const label = [...neighbors].filter((m) => !f.months.includes(m)).sort().map((m) => monthShort(`${m}-01`, ctx.lang)).join(", ");
    actions.push({ label: ctx.t("explore.neighborMonths", { months: label }), primary: true, onClick: () => go({ ...f, months }) });
  }
  if (!f.tier2) actions.push({ label: ctx.t("filters.tier2On"), primary: !actions.length, onClick: () => go({ ...f, tier2: true }) });
  const otherCountries = data.index.countries.filter((c) => !f.countries.includes(c.code));
  if (f.countries.length && otherCountries.length) actions.push({ label: ctx.t("explore.allCountries"), onClick: () => go({ ...f, countries: [] }) });
  if (f.from || f.to) {
    const { from: _from, to: _to, ...rest } = f;
    actions.push({ label: ctx.t("explore.clearDates"), onClick: () => go(rest) });
  }
  actions.push({ label: ctx.t("filters.clear"), onClick: () => go({ ...EMPTY_FILTERS }) });
  return actions;
}

function travelDates(f: ExploreState, count: number, ctx: Ctx, go: (next: ExploreState) => void): HTMLElement {
  const from = h("input", { type: "date", id: "trip-from", name: "desde", value: f.from ?? "", min: ctx.today, "data-key": "trip-from", class: "date-input num" });
  const to = h("input", { type: "date", id: "trip-to", name: "hasta", value: f.to ?? "", min: f.from ?? ctx.today, "data-key": "trip-to", class: "date-input num" });
  const apply = (): void => {
    const next: ExploreState = { ...f };
    delete next.from;
    delete next.to;
    const a = /^\d{4}-\d{2}-\d{2}$/.test(from.value) ? from.value : undefined;
    const b = /^\d{4}-\d{2}-\d{2}$/.test(to.value) ? to.value : undefined;
    go({ ...next, ...(a ? { from: a } : {}), ...(b ? { to: b } : {}) });
  };
  from.addEventListener("change", apply);
  to.addEventListener("change", apply);
  const active = !!(f.from || f.to);
  return h(
    "fieldset",
    { class: `trip${active ? " trip--active" : ""}` },
    h("legend", { class: "trip__legend" }, icon("calendar"), ctx.t("filters.trip"), active ? h("span", { class: "chip__count num", "aria-hidden": "true" }, String(count)) : null),
    h(
      "div",
      { class: "trip__fields" },
      h("div", { class: "field" }, h("label", { for: "trip-from" }, ctx.t("filters.from")), from),
      h("div", { class: "field" }, h("label", { for: "trip-to" }, ctx.t("filters.to")), to),
    ),
    active ? h("p", { class: "trip__hint" }, ctx.t("filters.tripHint")) : null,
  );
}

function content(f: ExploreState, data: ExploreData, ctx: Ctx): Child {
  const go = (next: ExploreState): void => ctx.navigate({ name: "explore", filters: next });
  const hits = run(data.all, f, ctx.today);
  const months = rollingMonths(ctx.today);
  const near = f.sort === "near";

  const countryChips = data.index.countries.map((c) =>
    chip(ctx, countryName(c.code, ctx.lang), run(data.all, { ...f, countries: [c.code] }, ctx.today).length, f.countries.includes(c.code), `pais-${c.code}`, () => go({ ...f, countries: toggle(f.countries, c.code) })),
  );
  const monthChips = months.map((m, i) =>
    chip(
      ctx,
      h(
        "span",
        null,
        h("span", { "aria-hidden": "true" }, monthShort(`${m}-01`, ctx.lang)),
        i === 0 || m.endsWith("-01") ? h("span", { class: "chip__year num", "aria-hidden": "true" }, ` ${m.slice(0, 4)}`) : null,
        h("span", { class: "sr-only" }, monthLabel(`${m}-01`, ctx.lang)),
      ),
      run(data.all, { ...f, months: [m] }, ctx.today).length,
      f.months.includes(m),
      `mes-${m}`,
      () => go({ ...f, months: toggle(f.months, m) }),
    ),
  );
  const typeChips = FESTIVAL_TYPES.map((type: FestivalType) =>
    chip(ctx, ctx.t(`type.${type}`), run(data.all, { ...f, types: [type] }, ctx.today).length, f.types.includes(type), `tipo-${type}`, () => go({ ...f, types: toggle(f.types, type) }), h("span", { class: `swatch type--${type}`, "aria-hidden": "true" })),
  );
  const tier2Count = run(data.all, { ...f, tier2: true }, ctx.today).length;

  const filters = h(
    "div",
    { class: "filters" },
    travelDates(f, hits.length, ctx, go),
    chipRow(ctx.t("filters.country"), "fl-country", countryChips),
    chipRow(ctx.t("filters.month"), "fl-month", monthChips),
    chipRow(ctx.t("filters.type"), "fl-type", typeChips),
    h(
      "div",
      { class: "filters__line" },
      h(
        "button",
        { type: "button", role: "switch", class: "switch", "aria-checked": String(f.tier2), "data-key": "tier2", onclick: () => go({ ...f, tier2: !f.tier2 }) },
        h("span", { class: "switch__track", "aria-hidden": "true" }, h("span", { class: "switch__thumb" })),
        h("span", { class: "switch__label" }, ctx.t("filters.tier2"), h("span", { class: "sr-only" }, `(${ctx.t("explore.count", { count: tier2Count })})`)),
        h("span", { class: "chip__count num", "aria-hidden": "true" }, String(tier2Count)),
      ),
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": ctx.t("explore.sort") },
        h("button", { type: "button", class: "segmented__opt", "aria-pressed": String(!near), "data-key": "sort-date", onclick: () => go({ ...f, sort: "date" }) }, ctx.t("explore.sortDate")),
        h(
          "button",
          {
            type: "button",
            class: "segmented__opt",
            "aria-pressed": String(near),
            "data-key": "sort-near",
            onclick: () => {
              if (ctx.geo().status !== "on") ctx.requestGeo();
              go({ ...f, sort: "near" });
            },
          },
          icon("pin"),
          ctx.t("explore.sortNear"),
        ),
      ),
    ),
  );

  const active = hasActiveFilters(f);
  const summary = h(
    "div",
    { class: "summary" },
    h("p", { class: "summary__count", role: "status", "aria-live": "polite", "data-testid": "result-count" }, ctx.t("explore.results", { count: hits.length })),
    h(
      "button",
      { type: "button", class: "btn btn--ghost summary__clear", "data-key": "clear", disabled: !active, onclick: () => go({ ...EMPTY_FILTERS, sort: f.sort }) },
      icon("close"),
      ctx.t("filters.clear"),
    ),
  );

  const results = hits.length
    ? near
      ? nearList(hits, ctx)
      : grouped(hits, ctx)
    : emptyState(ctx.t("explore.emptyTitle"), ctx.t("explore.emptyBody"), emptyActions(f, data, ctx, go));

  const worldHint = f.countries.length ? null : h("p", { class: "explore-hint" }, icon("globe"), ctx.t("explore.worldHint"));
  return [filters, summary, worldHint, h("div", { class: "results", "data-testid": "results" }, results)];
}

export function renderExplore(f: ExploreState, ctx: Ctx): HTMLElement {
  ctx.title(ctx.t("explore.title"));
  const res = resource(`explore|${ctx.today}`, () => loadExplore(ctx.today));
  return h(
    "div",
    { class: "screen screen--explore" },
    h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("explore.title")),
    asyncView(res, "list", ctx, (data) => content(f, data, ctx)),
  );
}
