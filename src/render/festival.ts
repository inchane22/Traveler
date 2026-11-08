// Ficha (RF-06, RF-07, RF-08, RF-17, RF-19, R6): names, place, dates in the UI language with
// their status and confidence, score breakdown, key events, street tips, sources and the
// sticky «Guardar» / «Agregar al calendario» bar in the thumb zone.
import { effectiveEnd, effectiveStart, type ISO, type Occurrence } from "../dates.ts";
import { isPendingPostponement, type FestivalEntry } from "../festivals.ts";
import { h, type Child } from "../h.ts";
import { countryName } from "../ics.ts";
import type { Festival, KeyEvent, Lang, LocalizedText, Rule, ScoreInputs, Source } from "../schema.ts";
import type { CriterionKey } from "../score.ts";
import { openCalendarSheet } from "./calendar.ts";
import {
  asyncView,
  bandMod,
  confidenceMark,
  countdownBlock,
  emptyState,
  externalLink,
  festivalName,
  issueUrl,
  moonNote,
  notice,
  occurrenceDates,
  saveButton,
  sectionHeading,
  staleNotice,
  statusBadge,
  typeTag,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { compactNumber, dayMonth, fullNumber, longDate, range, relativeDays, shortDate } from "./format.ts";
import { icon } from "./icons.ts";
import { advisoryFor, countryInfo, dateKind, dateSource, eventSource, isUnconfirmed, loadFestival, primarySource, resource, type FestivalData } from "./model.ts";
import { monthGrid } from "./monthgrid.ts";

const DEFAULT_REPO = "inchane22/traveler";

const text = (v: LocalizedText | undefined, lang: Lang): string | null => (v ? (v[lang] ?? v.es) : null);

/** A date that opens its source in one tap; without a source it says where it comes from. */
function sourcedDate(label: string, source: Source | undefined, ctx: Ctx, cls: string): HTMLElement {
  if (!source) return h("span", { class: `${cls} num` }, label);
  return h(
    "a",
    { href: source.url, external: true, class: `${cls} num link--source` },
    label,
    h("span", { class: "sr-only" }, ` ${ctx.t("festival.sourceOf", { publisher: source.publisher })} ${ctx.t("link.newTab")}`),
    icon("external"),
  );
}

export function ruleText(rule: Rule, lang: Lang, ctx: Ctx, year: number): string {
  const parity = rule.parity ? ` ${ctx.t(`rule.parity.${rule.parity}`)}` : "";
  const md = (v: string): string => dayMonth(`${year}-${v}`, lang);
  switch (rule.type) {
    case "fixed":
      return ctx.t("rule.fixed", { from: md(rule.start), to: md(rule.end) }) + parity;
    case "easter_offset":
      return ctx.t(rule.start < 0 ? "rule.easterBefore" : "rule.easterAfter", { days: Math.abs(rule.start), calendar: ctx.t(`rule.calendar.${rule.calendar}`) }) + parity;
    case "nth_weekday":
      return ctx.t("rule.nthWeekday", { nth: ctx.t(`rule.nth.${rule.n}`), weekday: weekdayName(rule.weekday, lang), month: monthOnly(rule.month, lang), count: rule.duration_days }) + parity;
    case "relative_to":
      return ctx.t("rule.relative", { count: Math.abs(rule.offset) }) + parity;
    case "lunisolar_table":
      return ctx.t("rule.lunisolar", { calendar: ctx.t(`rule.lunar.${rule.calendar}`) }) + parity;
    case "announced":
      return ctx.t("rule.announced", { from: md(rule.window.start), to: md(rule.window.end) }) + parity;
  }
}

function weekdayName(dow: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + dow));
}

function monthOnly(month: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" }).format(Date.UTC(2023, month - 1, 1));
}

function measureText(key: CriterionKey, inputs: ScoreInputs, ctx: Ctx): string | null {
  const m = inputs[key];
  if (!m) return null;
  let base: string;
  if (key === "convocatoria") {
    const c = inputs.convocatoria!.measure;
    const n = c.qualifier === "exact" ? fullNumber(c.attendance, ctx.lang) : compactNumber(c.attendance, ctx.lang);
    base = ctx.t("measure.attendance", { amount: ctx.t(`measure.qualifier.${c.qualifier}`, { n }), unit: ctx.t(`measure.unit.${c.unit}`), year: String(c.year) });
  } else {
    base = ctx.t(`measure.${key}.${String(m.measure)}`);
  }
  const note = text(m.note, ctx.lang);
  return note ? `${base}. ${note}` : base;
}

function scoreSection(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const { score, festival } = entry;
  const measured = score.low === score.high;
  const total = measured ? String(score.low) : ctx.t("score.range", { low: score.low, high: score.high });
  const ruler = h(
    "div",
    { class: "ruler", "aria-hidden": "true" },
    score.criteria.map((c) =>
      h(
        "span",
        { class: "ruler__seg", style: { "--max": String(c.max) } },
        c.points === null ? h("span", { class: "ruler__fill band--hatched", style: { "--p": "1" } }) : h("span", { class: "ruler__fill", style: { "--p": String(c.points / c.max) } }),
      ),
    ),
  );
  const rows = score.criteria.map((c) => {
    const input = festival.score[c.key];
    const desc = measureText(c.key, festival.score, ctx);
    return h(
      "li",
      { class: `crit${c.points === null ? " crit--unmeasured" : ""}` },
      h(
        "div",
        { class: "crit__head" },
        h("span", { class: "crit__name" }, ctx.t(`criterion.${c.key}`)),
        h("span", { class: "crit__pts num" }, c.points === null ? ctx.t("score.unmeasured") : ctx.t("score.points", { points: c.points, max: c.max })),
      ),
      h(
        "div",
        { class: "crit__bar", "aria-hidden": "true" },
        h("span", { class: `crit__fill${c.points === null ? " band--hatched" : ""}`, style: { "--p": String(c.points === null ? 1 : c.points / c.max) } }),
      ),
      h(
        "p",
        { class: "crit__desc" },
        desc ?? ctx.t("score.unmeasuredDesc", { max: c.max }),
        input ? [" ", confidenceMark(input.confidence, ctx.t)] : null,
        input?.source ? [" ", externalLink(input.source, ctx.t("festival.source"), ctx.t, "link link--small")] : null,
      ),
    );
  });
  return h(
    "section",
    { class: "section", "aria-labelledby": "score-title" },
    sectionHeading(ctx.t("score.title"), "score-title"),
    h(
      "div",
      { class: "score-total" },
      h("p", { class: "score-total__value num" }, total, h("span", { class: "score-total__max" }, ctx.t("score.of100"))),
      h("p", { class: "score-total__tier" }, ctx.t(`tier.${String(score.tier)}`), !measured ? h("span", { class: "score-total__why" }, ctx.t("score.rangeWhy")) : null),
    ),
    ruler,
    h("ul", { class: "crits" }, rows),
    h("p", { class: "section__foot" }, h("a", { href: ctx.href({ name: "about" }), class: "link" }, ctx.t("score.how"))),
  );
}

/**
 * A key event's day as plain text, then where it comes from. A sourced day's confidence label is
 * the link to that source («● Oficial ↗», one tap); a day no source gives says why instead.
 */
function eventWhen(ev: KeyEvent, occ: Occurrence | null, ctx: Ctx): Child[] {
  if (!ev.date) return [h("span", { class: "event__date" }, ctx.t("status.por_anunciar")), confidenceMark(ev.confidence, ctx.t)];
  const label = ev.end && ev.end !== ev.date ? range(ev.date, ev.end, ctx.lang) : longDate(ev.date, ctx.lang);
  const date = h("span", { class: "event__date num" }, label);
  const source = eventSource(ev, occ);
  if (source) {
    return [
      date,
      h(
        "a",
        { href: source.url, external: true, class: "event__source link--source" },
        confidenceMark(ev.confidence, ctx.t),
        h("span", { class: "sr-only" }, `, ${ctx.t("festival.sourceOf", { publisher: source.publisher })} ${ctx.t("link.newTab")}`),
        icon("external"),
      ),
    ];
  }
  // No source backs this day: say where it comes from instead of borrowing the edition's publisher.
  const why = ev.rule ? ctx.t("festival.fromRule", { rule: ruleText(ev.rule, ctx.lang, ctx, Number(ev.date.slice(0, 4))) }) : ctx.t("festival.eventUnsourced");
  return [date, confidenceMark(ev.confidence, ctx.t), h("span", { class: "event__rule" }, why)];
}

function keyEvents(occ: Occurrence | null, ctx: Ctx): HTMLElement | null {
  const events = occ?.edition?.key_events ?? [];
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  return h(
    "section",
    { class: "section", "aria-labelledby": "events-title" },
    sectionHeading(ctx.t("festival.keyEvents"), "events-title"),
    h(
      "ol",
      { class: "events" },
      sorted.map((ev) => h("li", { class: "event" }, h("span", { class: "event__name" }, text(ev.name, ctx.lang) ?? ev.id), h("span", { class: "event__when" }, eventWhen(ev, occ, ctx)))),
    ),
  );
}

function streetSection(f: Festival, ctx: Ctx): HTMLElement | null {
  const tip = text(f.street_tip, ctx.lang);
  const etiquette = text(f.etiquette, ctx.lang);
  if (!tip && !etiquette) return null;
  return h(
    "section",
    { class: "section street", "aria-labelledby": "street-title" },
    sectionHeading(ctx.t("festival.street"), "street-title"),
    tip ? h("p", { class: "street__tip" }, tip) : null,
    etiquette ? h("div", { class: "street__etiquette" }, h("h3", { class: "street__sub" }, ctx.t("festival.etiquette")), h("p", null, etiquette)) : null,
  );
}

const TIER_LABEL: Record<string, string> = { A: "source.tierA", B: "source.tierB", C: "source.tierC" };

function sourcesSection(occ: Occurrence | null, entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const sources = occ?.edition?.sources ?? [];
  const lastVerified = occ?.edition?.last_verified;
  return h(
    "section",
    { class: "section", "aria-labelledby": "sources-title" },
    sectionHeading(ctx.t("festival.sources"), "sources-title"),
    lastVerified ? h("p", { class: "freshness" }, icon("check"), ctx.t("fresh.verifiedOn", { when: relativeDays(lastVerified, ctx.today, ctx.lang), date: shortDate(lastVerified, ctx.lang) })) : null,
    sources.length
      ? h(
          "ul",
          { class: "sources" },
          sources.map((src) =>
            h(
              "li",
              { class: "source" },
              externalLink(src.url, src.publisher, ctx.t, "source__link"),
              h(
                "p",
                { class: "source__meta" },
                h("span", null, ctx.t("source.accessed", { date: shortDate(src.accessed, ctx.lang) })),
                src.tier ? h("span", { class: "tag" }, ctx.t(TIER_LABEL[src.tier] ?? "source.tierC")) : null,
                src.archive_url ? externalLink(src.archive_url, ctx.t("source.archive"), ctx.t, "link link--small") : null,
              ),
            ),
          ),
        )
      : h("p", { class: "section__lede" }, ctx.t("festival.noSources", { rule: ruleText(entry.festival.rule, ctx.lang, ctx, occ?.year ?? Number(ctx.today.slice(0, 4))) })),
  );
}

function reportSection(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const year = entry.occurrence?.year;
  const slug = entry.festival.slug;
  const name = festivalName(entry.festival, "es");
  // Title prefixes match the issue templates in .github (triage reads them), so they stay Spanish.
  const errorUrl = issueUrl(ctx.repo, "reportar-error.yml", ctx.t("report.errorIssueTitle", { name: year ? `${name} ${year}` : name }), {
    fiesta: slug,
    campo: year ? `editions.${year}.start/end` : undefined,
    fuente: primarySource(entry.occurrence)?.url,
  });
  const contentUrl = issueUrl(ctx.repo, "reportar-contenido.yml", ctx.t("report.contentIssueTitle", { name }), { fiesta: slug });
  return h(
    "section",
    { class: "section report", "aria-labelledby": "report-title" },
    sectionHeading(ctx.t("report.title"), "report-title"),
    h("p", { class: "section__lede" }, ctx.t("report.body")),
    h(
      "ul",
      { class: "report__links" },
      h("li", null, externalLink(errorUrl, ctx.t("report.error"), ctx.t, "btn btn--secondary")),
      h("li", null, externalLink(contentUrl, ctx.t("report.content"), ctx.t, "btn btn--secondary")),
    ),
  );
}

function advisorySection(entry: FestivalEntry, ctx: Ctx): HTMLElement | null {
  const origin = ctx.store.get("origin");
  if (!origin || origin === entry.country) return null; // no origin chosen, or a trip at home
  const adv = advisoryFor(origin, entry.country);
  const params = { origin: countryName(origin, ctx.lang), country: countryName(entry.country, ctx.lang) };
  if (!adv) {
    return h(
      "section",
      { class: "section advisory", "aria-labelledby": "advisory-title" },
      sectionHeading(ctx.t("advisory.title"), "advisory-title"),
      h("p", { class: "section__lede advisory__missing" }, ctx.t("advisory.missing", params)),
    );
  }
  // Literal keys on both branches so the i18n test sees them.
  const consular = adv.kind === "consular";
  const lede = consular ? ctx.t("advisory.bodyConsular", params) : ctx.t("advisory.body", params);
  const label = consular ? ctx.t("advisory.consular") : ctx.t("advisory.link", params);
  return h(
    "section",
    { class: "section advisory", "aria-labelledby": "advisory-title" },
    sectionHeading(ctx.t("advisory.title"), "advisory-title"),
    h("p", { class: "section__lede" }, lede),
    externalLink(adv.url, label, ctx.t, "btn btn--secondary"),
    adv.publisher ? h("p", { class: "advisory__publisher" }, adv.publisher) : null,
  );
}

function whenBlock(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  const occ = entry.occurrence;
  const source = dateSource(occ);
  const kind = dateKind(occ);
  const dates = occurrenceDates(occ, ctx.lang, ctx.t);
  const longRange = occ?.start && occ.end ? (occ.start === occ.end ? longDate(occ.start, ctx.lang) : `${longDate(occ.start, ctx.lang)} – ${longDate(occ.end, ctx.lang)}`) : null;
  const eventDates = (occ?.edition?.key_events ?? []).map((e) => e.date).filter((d): d is ISO => !!d);
  const note = text(occ?.edition?.note, ctx.lang);
  // A pending postponement keeps only its original window: no rule line, no past month grid.
  const pending = !!occ && isPendingPostponement(occ);
  const mark = occ && kind !== "none" && !pending ? { start: effectiveStart(occ), end: effectiveEnd(occ), mod: kind === "window" ? ("window" as const) : isUnconfirmed(occ) ? ("hatched" as const) : ("solid" as const) } : null;
  return h(
    "section",
    { class: `when type--${entry.festival.type}${occ?.status === "cancelada" ? " is-cancelled" : ""}`, "aria-labelledby": "when-title" },
    // One band per ficha, on the dates card's top edge like the Inicio poster: same date code.
    h("span", { class: `band band--${bandMod(occ)} when__band`, "aria-hidden": "true" }),
    h("h2", { class: "sr-only", id: "when-title" }, ctx.t("festival.when")),
    h("div", { class: "when__dates" }, sourcedDate(dates, source, ctx, "when__range")),
    longRange ? h("p", { class: "when__long" }, longRange) : null,
    occ ? h("p", { class: "marks marks--lg" }, statusBadge(occ.status, ctx.t), confidenceMark(occ.confidence, ctx.t, true)) : null,
    moonNote(occ, ctx.t),
    note ? h("p", { class: "when__note" }, note) : null,
    !source && occ && !pending ? h("p", { class: "when__rule" }, ctx.t("festival.fromRule", { rule: ruleText(entry.festival.rule, ctx.lang, ctx, occ.year) })) : null,
    countdownBlock(occ, ctx),
    mark ? monthGrid(mark, eventDates, ctx) : null,
  );
}

function cancelledNotice(entry: FestivalEntry, ctx: Ctx): HTMLElement | null {
  const occ = entry.occurrence;
  if (!occ || (occ.status !== "cancelada" && occ.status !== "aplazada")) return null;
  const src = primarySource(occ);
  const key = occ.status === "cancelada" ? "festival.cancelledNotice" : "festival.postponedNotice";
  return notice("cancel", "alert", h("p", null, ctx.t(key, { year: String(occ.year) }), " ", src ? externalLink(src.url, src.publisher, ctx.t) : null));
}

function actionBar(entry: FestivalEntry, ctx: Ctx): HTMLElement {
  return h(
    "div",
    { class: "actionbar" },
    h(
      "div",
      { class: "actionbar__inner" },
      saveButton(entry, ctx, "full"),
      h(
        "button",
        { type: "button", class: "btn btn--primary actionbar__cal", "data-key": "add-calendar", "aria-haspopup": "dialog", onclick: () => openCalendarSheet(entry, ctx) },
        icon("calendar"),
        ctx.t("calendar.add"),
      ),
    ),
  );
}

function content(data: FestivalData, ctx: Ctx): Child {
  const { entry, country } = data;
  const f = entry.festival;
  const name = festivalName(f, ctx.lang);
  ctx.title(name);
  const original = f.names.local !== name ? f.names.local : null;
  return [
    country.status === "borrador" ? notice("draft", "alert", h("p", null, ctx.t("draft.banner"))) : null,
    staleNotice(countryInfo(data.index, entry.country), ctx),
    cancelledNotice(entry, ctx),
    h(
      "header",
      { class: `fhead type--${f.type}` },
      h("p", { class: "fhead__type" }, typeTag(f.type, ctx.t), h("span", { class: "tag" }, ctx.t(`tier.${String(entry.score.tier)}`))),
      h("h1", { class: `screen-title fhead__name display${entry.occurrence?.status === "cancelada" ? " is-struck" : ""}`, tabindex: "-1" }, name),
      original ? h("p", { class: "fhead__original" }, ctx.t("festival.original"), " ", h("span", { class: "fhead__original-name" }, original)) : null,
      h("p", { class: "fhead__place" }, icon("pin"), `${f.city}, ${countryName(entry.country, ctx.lang)}`),
    ),
    whenBlock(entry, ctx),
    keyEvents(entry.occurrence, ctx),
    streetSection(f, ctx),
    scoreSection(entry, ctx),
    sourcesSection(entry.occurrence, entry, ctx),
    advisorySection(entry, ctx),
    reportSection(entry, ctx),
    actionBar(entry, ctx),
  ];
}

export function renderFestival(slug: string, ctx: Ctx): HTMLElement {
  const res = resource(`festival|${slug}|${ctx.today}`, () => loadFestival(slug, ctx.today));
  return h(
    "div",
    { class: "screen screen--festival" },
    asyncView(res, "detail", ctx, (data) => {
      if (!data) {
        ctx.title(ctx.t("notfound.title"));
        return [
          h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("notfound.festivalTitle")),
          emptyState(ctx.t("notfound.festivalBody"), null, [
            { label: ctx.t("nav.explore"), href: ctx.href({ name: "explore", filters: { countries: [], months: [], types: [], tier2: false, sort: "date" } }), primary: true },
            { label: ctx.t("nav.home"), href: ctx.href({ name: "home", query: { tier2: false } }) },
          ]),
        ];
      }
      return content(data, ctx);
    }),
  );
}

export { DEFAULT_REPO };
