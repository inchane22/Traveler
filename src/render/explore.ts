// Explorar (RF-03, RF-04, RF-14): month-grouped list with filter chips. Every chip shows how many
// festivals it would give; all state lives in the hash so links share and Back restores filters.
// Phones keep «Mis fechas de viaje» and the active filters in view and the rest of the chips in a
// sheet (draft, then «Ver N fiestas»: one history entry), so the list starts above the fold; from
// 48rem the same chips sit inline and apply at once.
import { addDays, addMonths, effectiveStart, type ISO } from "../dates.ts";
import { applyFilters, isVisible, type FestivalEntry, type FilterHit } from "../festivals.ts";
import { h, type Child } from "../h.ts";
import { countryName } from "../ics.ts";
import { EMPTY_FILTERS, FESTIVAL_TYPES, hasActiveFilters, type ExploreState } from "../router.ts";
import type { FestivalType } from "../schema.ts";
import {
  asyncView,
  dateBand,
  emptyState,
  festivalName,
  liveNote,
  locationAction,
  locationProblem,
  occurrenceDates,
  placeLine,
  saveButton,
  staleNotice,
  suggestAction,
  trustMark,
  typeTag,
  type EmptyAction,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { dayNumber, monthLabel, monthShort } from "./format.ts";
import { resource } from "../resource.ts";
import { entriesFor, filtersFrom, haversineKm, loadCountry, loadIndex, rollingMonths, type PublicIndex } from "./model.ts";
import { icon } from "./icons.ts";
import { marksButton } from "./marks.ts";
import { openSheet } from "./sheet.ts";

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

/** Filters behind the «Filtros» button (dates stay in view): what its badge counts. */
function sheetFilterCount(f: ExploreState): number {
  return f.countries.length + f.months.length + f.types.length + (f.tier2 ? 1 : 0) + (f.sort === "near" ? 1 : 0);
}

/**
 * A counted filter chip. A chip that would give nothing is muted and inert (aria-disabled, still
 * focusable and announced with its 0), unless it is already on: that one must stay removable.
 */
function chip(ctx: Ctx, label: Child, count: number, pressed: boolean, key: string, onClick: () => void, extra?: Child): HTMLElement {
  const inert = count === 0 && !pressed;
  return h(
    "button",
    {
      type: "button",
      class: `chip${inert ? " chip--zero" : ""}`,
      "aria-pressed": String(pressed),
      "aria-disabled": inert ? "true" : null,
      "data-key": key,
      onclick: () => {
        if (!inert) onClick();
      },
    },
    extra ?? null,
    h("span", { class: "chip__label" }, label, h("span", { class: "sr-only" }, `(${ctx.t("explore.count", { count })})`)),
    h("span", { class: "chip__count num", "aria-hidden": "true" }, String(count)),
  );
}

function chipRow(label: string, id: string, scrollKey: string, chips: HTMLElement[]): HTMLElement {
  return h(
    "div",
    { class: "chip-group", role: "group", "aria-labelledby": id },
    h("span", { class: "chip-group__label", id }, label),
    h("div", { class: "chip-row", "data-scroll-key": scrollKey }, chips),
  );
}

interface GroupOptions {
  /** Prefix for ids and data-keys, so the inline panel and the sheet never share one. */
  prefix: string;
  change: (next: ExploreState) => void;
  /** Inline only: «Cerca de mí» asks for the location as it applies. */
  askGeo: boolean;
}

/** Country, month and type chips, the Nivel 2 switch and the sort, counted against `f`. */
function filterGroups(f: ExploreState, data: ExploreData, ctx: Ctx, opts: GroupOptions): HTMLElement[] {
  const { prefix, change } = opts;
  const key = (k: string): string => (prefix ? `${prefix}-${k}` : k);
  const months = rollingMonths(ctx.today);
  const near = f.sort === "near";

  const countryChips = data.index.countries.map((c) =>
    chip(ctx, countryName(c.code, ctx.lang), run(data.all, { ...f, countries: [c.code] }, ctx.today).length, f.countries.includes(c.code), key(`pais-${c.code}`), () => change({ ...f, countries: toggle(f.countries, c.code) })),
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
      key(`mes-${m}`),
      () => change({ ...f, months: toggle(f.months, m) }),
    ),
  );
  const typeChips = FESTIVAL_TYPES.map((type: FestivalType) =>
    chip(ctx, ctx.t(`type.${type}`), run(data.all, { ...f, types: [type] }, ctx.today).length, f.types.includes(type), key(`tipo-${type}`), () => change({ ...f, types: toggle(f.types, type) }), h("span", { class: `swatch type--${type}`, "aria-hidden": "true" })),
  );
  const tier2Count = run(data.all, { ...f, tier2: true }, ctx.today).length;
  const id = (k: string): string => `${prefix || "fl"}-${k}`;

  return [
    chipRow(ctx.t("filters.country"), id("country"), key("row-country"), countryChips),
    chipRow(ctx.t("filters.month"), id("month"), key("row-month"), monthChips),
    chipRow(ctx.t("filters.type"), id("type"), key("row-type"), typeChips),
    h(
      "div",
      { class: "filters__line" },
      h(
        "button",
        { type: "button", role: "switch", class: "switch", "aria-checked": String(f.tier2), "data-key": key("tier2"), onclick: () => change({ ...f, tier2: !f.tier2 }) },
        h("span", { class: "switch__track", "aria-hidden": "true" }, h("span", { class: "switch__thumb" })),
        h("span", { class: "switch__label" }, ctx.t("filters.tier2"), h("span", { class: "sr-only" }, `(${ctx.t("explore.count", { count: tier2Count })})`)),
        h("span", { class: "chip__count num", "aria-hidden": "true" }, String(tier2Count)),
      ),
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": ctx.t("explore.sort") },
        h("button", { type: "button", class: "segmented__opt", "aria-pressed": String(!near), "data-key": key("sort-date"), onclick: () => change({ ...f, sort: "date" }) }, ctx.t("explore.sortDate")),
        h(
          "button",
          {
            type: "button",
            class: "segmented__opt",
            "aria-pressed": String(near),
            "data-key": key("sort-near"),
            onclick: () => {
              if (opts.askGeo) ctx.requestGeo();
              change({ ...f, sort: "near" });
            },
          },
          icon("pin"),
          ctx.t("explore.sortNear"),
        ),
      ),
    ),
  ];
}

/**
 * Phones: the chips in a sheet, drafted locally with live counts; «Ver N fiestas» applies them as
 * one navigation (one history entry, so Back restores the previous filters). Closing discards.
 */
function openFilterSheet(initial: ExploreState, data: ExploreData, ctx: Ctx, go: (next: ExploreState) => void, opener: HTMLElement): void {
  let draft: ExploreState = { ...initial };
  const groups = h("div", { class: "filter-sheet__groups" });
  const foot = h("div", { class: "sheet__foot" });
  let dialog: HTMLDialogElement | null = null;

  const paint = (): void => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-key]")?.dataset.key : undefined;
    const body = dialog?.querySelector<HTMLElement>(".sheet__body");
    const top = body?.scrollTop ?? 0;
    groups.replaceChildren(
      ...filterGroups(draft, data, ctx, {
        prefix: "sh",
        askGeo: false,
        change: (next) => {
          draft = next;
          paint();
        },
      }),
    );
    const count = run(data.all, draft, ctx.today).length;
    const resetTo: ExploreState = { ...draft, countries: [], months: [], types: [], tier2: false, sort: "date" };
    foot.replaceChildren(
      h(
        "button",
        {
          type: "button",
          class: "btn btn--ghost",
          "data-key": "sh-reset",
          disabled: !sheetFilterCount(draft),
          onclick: () => {
            draft = resetTo;
            paint();
          },
        },
        ctx.t("filters.reset"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary sheet__apply",
          "data-key": "sh-apply",
          "data-testid": "filters-apply",
          onclick: () => {
            const next = draft;
            dialog?.close();
            // Focus goes back to «Filtros» first, so the re-render keeps it there.
            opener.focus();
            if (next.sort === "near") ctx.requestGeo();
            go(next);
          },
        },
        ctx.t("filters.apply", { count }),
      ),
    );
    if (body) body.scrollTop = top;
    if (focused && dialog) dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  };

  dialog = openSheet({
    id: "filter-sheet",
    title: ctx.t("filters.open"),
    closeLabel: ctx.t("sheet.close"),
    body: () => h("div", { class: "filter-sheet" }, h("p", { class: "sheet__note" }, ctx.t("filters.countHelp")), groups),
    footer: foot,
  });
  paint();
}

/** Phones: the filters that are on, each removable in one tap (dates have their own fields). */
function activeChips(f: ExploreState, ctx: Ctx, go: (next: ExploreState) => void): HTMLElement | null {
  const items: { key: string; label: Child; next: ExploreState }[] = [
    ...f.countries.map((c) => ({ key: `pais-${c}`, label: countryName(c, ctx.lang), next: { ...f, countries: f.countries.filter((x) => x !== c) } })),
    ...f.months.map((m) => ({ key: `mes-${m}`, label: monthLabel(`${m}-01`, ctx.lang), next: { ...f, months: f.months.filter((x) => x !== m) } })),
    ...f.types.map((t) => ({ key: `tipo-${t}`, label: [h("span", { class: `swatch type--${t}`, "aria-hidden": "true" }), ctx.t(`type.${t}`)], next: { ...f, types: f.types.filter((x) => x !== t) } })),
    ...(f.tier2 ? [{ key: "tier2", label: ctx.t("filters.tier2Chip"), next: { ...f, tier2: false } }] : []),
    ...(f.sort === "near" ? [{ key: "near", label: ctx.t("explore.sortNear"), next: { ...f, sort: "date" as const } }] : []),
  ];
  if (!items.length) return null;
  const remove = (i: number): void => {
    // Focus moves to the next chip that stays (or «Filtros») before the list re-renders.
    const stay = items[i + 1] ?? items[i - 1];
    const target = document.querySelector<HTMLElement>(`[data-key="${stay ? `active-${stay.key}` : "filters-open"}"]`);
    target?.focus({ preventScroll: true });
    go(items[i]!.next);
  };
  return h(
    "div",
    { class: "active-filters", role: "group", "aria-label": ctx.t("filters.active") },
    h(
      "ul",
      { class: "active-filters__list" },
      items.map((item, i) =>
        h("li", null, h("button", { type: "button", class: "pill pill--remove", "data-key": `active-${item.key}`, onclick: () => remove(i) }, h("span", { class: "sr-only" }, `${ctx.t("filters.remove")} `), item.label, icon("close"))),
      ),
    ),
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
        trustMark(occ, ctx.t),
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

/**
 * Distance order needs the location (src/geo.ts). Until it is on, every state says where it
 * stands, as in Ajustes, and date order is one tap away; after a refusal it is the first way out.
 */
function nearList(hits: readonly FilterHit[], f: ExploreState, ctx: Ctx, go: (next: ExploreState) => void): Child {
  const geo = ctx.geo();
  if (geo.status !== "on") {
    const refused = geo.status === "denied" || geo.status === "unavailable";
    const byDate: EmptyAction = { label: ctx.t("near.byDate"), primary: refused, key: "near-by-date", onClick: () => go({ ...f, sort: "date" }) };
    return [locationProblem(ctx), emptyState(ctx.t("near.needTitle"), ctx.t("near.needBody"), refused ? [byDate, locationAction(ctx, false)] : [locationAction(ctx), byDate])];
  }
  const withDist = hits
    .map((hit) => ({ hit, km: haversineKm(geo.coords, hit.entry.festival.coords) }))
    .sort((a, b) => a.km - b.km);
  return h("ul", { class: "fest-list fest-list--near" }, withDist.map(({ hit, km }) => row(hit, ctx, km)));
}

interface Candidate {
  label: string;
  next: ExploreState;
}

/**
 * «Vacíos que orientan»: every way out is counted with the same filters as the chips, only the
 * ones that give results are offered, each with its count, best first. Clearing every filter is
 * the last resort; with nothing published at all, suggesting a festival is the only way out.
 */
function emptyActions(f: ExploreState, data: ExploreData, ctx: Ctx, go: (next: ExploreState) => void): EmptyAction[] {
  const candidates: Candidate[] = [];
  if (f.months.length) {
    const neighbors = new Set<string>();
    for (const m of f.months) {
      neighbors.add(addDays(`${m}-01`, -1).slice(0, 7));
      neighbors.add(addDays(`${m}-28`, 7).slice(0, 7));
    }
    const months = [...new Set([...f.months, ...neighbors])].sort();
    const label = [...neighbors].filter((m) => !f.months.includes(m)).sort().map((m) => monthShort(`${m}-01`, ctx.lang)).join(", ");
    candidates.push({ label: ctx.t("explore.neighborMonths", { months: label }), next: { ...f, months } });
  }
  if (!f.tier2) candidates.push({ label: ctx.t("filters.tier2On"), next: { ...f, tier2: true } });
  if (f.types.length) candidates.push({ label: ctx.t("explore.clearTypes"), next: { ...f, types: [] } });
  if (f.months.length) candidates.push({ label: ctx.t("explore.clearMonths"), next: { ...f, months: [] } });
  const otherCountries = data.index.countries.filter((c) => !f.countries.includes(c.code));
  if (f.countries.length && otherCountries.length) candidates.push({ label: ctx.t("explore.allCountries"), next: { ...f, countries: [] } });
  if (f.from || f.to) {
    const { from: _from, to: _to, ...rest } = f;
    candidates.push({ label: ctx.t("explore.clearDates"), next: rest });
  }
  const counted = candidates
    .map((c) => ({ ...c, count: run(data.all, c.next, ctx.today).length }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const clearAll = { ...EMPTY_FILTERS, sort: f.sort };
  const clearCount = run(data.all, clearAll, ctx.today).length;
  const actions: EmptyAction[] = counted.map((c, i) => ({ label: ctx.t("explore.withCount", { label: c.label, count: c.count }), primary: i === 0, onClick: () => go(c.next) }));
  if (clearCount > 0 && hasActiveFilters(f)) actions.push({ label: ctx.t("explore.withCount", { label: ctx.t("filters.clear"), count: clearCount }), primary: !actions.length, onClick: () => go(clearAll) });
  return [...actions, suggestAction(ctx, f.countries.length === 1 ? f.countries[0] : undefined)];
}

/**
 * One-tap ranges from today; tapping the one in use clears the dates again. Short visible labels
 * keep them on one row at 390 px; the accessible name says «Próximos 30 días».
 */
function datePresets(f: ExploreState, ctx: Ctx, go: (next: ExploreState) => void): HTMLElement {
  const today = ctx.today;
  const next = h("span", { class: "sr-only" }, `${ctx.t("filters.preset.next")} `);
  const presets: { id: string; label: Child; from: ISO; to: ISO }[] = [
    { id: "month", label: ctx.t("filters.preset.month"), from: today, to: addDays(addMonths(`${today.slice(0, 7)}-01`, 1), -1) },
    { id: "30", label: [next, ctx.t("filters.preset.30")], from: today, to: addDays(today, 29) },
    { id: "90", label: [next.cloneNode(true), ctx.t("filters.preset.90")], from: today, to: addDays(addMonths(today, 3), -1) },
  ];
  const { from: _from, to: _to, ...withoutDates } = f;
  return h(
    "div",
    { class: "trip__presets", role: "group", "aria-label": ctx.t("filters.presets") },
    presets.map((p) => {
      const pressed = f.from === p.from && f.to === p.to;
      return h("button", { type: "button", class: "pill", "aria-pressed": String(pressed), "data-key": `preset-${p.id}`, onclick: () => go(pressed ? withoutDates : { ...f, from: p.from, to: p.to }) }, p.label);
    }),
  );
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
    datePresets(f, ctx, go),
    active ? h("p", { class: "trip__hint" }, ctx.t("filters.tripHint")) : null,
  );
}

/** World view: why only Nivel 1 shows, which countries are live, and a one-tap way into each country's own list. */
function worldHint(f: ExploreState, data: ExploreData, ctx: Ctx, go: (next: ExploreState) => void): HTMLElement | null {
  if (f.countries.length) return null;
  const ways = data.index.countries
    .slice(0, 3)
    .map((c) => ({ code: c.code, count: run(data.all, { ...f, countries: [c.code] }, ctx.today).length }))
    .filter((c) => c.count > 0);
  return h(
    "div",
    { class: "explore-hint" },
    icon("globe"),
    h(
      "div",
      { class: "explore-hint__body" },
      h("p", null, ctx.t("explore.worldHint")),
      liveNote(data.index, { kind: "world" }, ctx),
      ways.length
        ? h(
            "p",
            { class: "explore-hint__ways" },
            ways.map((c) =>
              h("button", { type: "button", class: "btn btn--secondary btn--small", "data-key": `hint-${c.code}`, onclick: () => go({ ...f, countries: [c.code] }) }, ctx.t("explore.seeCountry", { count: c.count, country: countryName(c.code, ctx.lang) })),
            ),
          )
        : null,
    ),
  );
}

function content(f: ExploreState, data: ExploreData, ctx: Ctx): Child {
  const go = (next: ExploreState): void => ctx.navigate({ name: "explore", filters: next });
  const hits = run(data.all, f, ctx.today);
  const near = f.sort === "near";
  const hidden = sheetFilterCount(f);

  const filtersButton: HTMLElement = h(
    "button",
    {
      type: "button",
      class: `btn btn--secondary filters-btn${hidden ? " filters-btn--on" : ""}`,
      "aria-haspopup": "dialog",
      "data-key": "filters-open",
      onclick: () => openFilterSheet(f, data, ctx, go, filtersButton),
    },
    icon("settings"),
    ctx.t("filters.open"),
    hidden ? [h("span", { class: "chip__count num", "aria-hidden": "true" }, String(hidden)), h("span", { class: "sr-only" }, ` (${ctx.t("filters.activeCount", { count: hidden })})`)] : null,
  );

  const filters = h(
    "div",
    { class: "filters" },
    travelDates(f, hits.length, ctx, go),
    h("div", { class: "filters__panel" }, filterGroups(f, data, ctx, { prefix: "", change: go, askGeo: true })),
  );

  const active = hasActiveFilters(f);
  const summary = h(
    "div",
    { class: "summary" },
    h("p", { class: "summary__count", role: "status", "aria-live": "polite", "data-testid": "result-count" }, ctx.t("explore.results", { count: hits.length })),
    h(
      "div",
      { class: "summary__actions" },
      filtersButton,
      h(
        "button",
        { type: "button", class: "btn btn--ghost summary__clear", "data-key": "clear", disabled: !active, onclick: () => go({ ...EMPTY_FILTERS, sort: f.sort }) },
        icon("close"),
        ctx.t("filters.clear"),
      ),
    ),
  );

  const results = hits.length
    ? near
      ? nearList(hits, f, ctx, go)
      : grouped(hits, ctx)
    : emptyState(ctx.t("explore.emptyTitle"), ctx.t("explore.emptyBody"), emptyActions(f, data, ctx, go));

  // RF-13: the warning travels with the dates. Chosen countries, or every country the list shows.
  const shown = f.countries.length ? f.countries : [...new Set(hits.map((hit) => hit.entry.country))];
  const stale = data.index.countries.filter((c) => shown.includes(c.code)).map((c) => staleNotice(c, ctx));
  return [
    stale,
    filters,
    summary,
    activeChips(f, ctx, go),
    worldHint(f, data, ctx, go),
    h("div", { class: "results", "data-testid": "results" }, results),
    hits.length ? h("p", { class: "explore-help" }, marksButton(ctx, "explore-marks")) : null,
  ];
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
