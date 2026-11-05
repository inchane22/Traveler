// Sobre los datos (#/datos, RF-13): how the score is computed (config/scoring.json), freshness per
// country, subscriptions and the changelog of approved changes.
import { h } from "../h.ts";
import { countryName } from "../ics.ts";
import type { ChangelogEntry, Festival } from "../schema.ts";
import { CRITERIA } from "../score.ts";
import { actionButton, asyncView, confidenceShape, emptyState, externalLink, festivalName, sectionHeading, statusShape, suggestAction } from "./components.ts";
import type { Ctx } from "./context.ts";
import { compactNumber, fullNumber, percent, relativeDays, shortDate } from "./format.ts";
import { icon } from "./icons.ts";
import { isStale, loadChangelog, loadCountry, loadIndex, PARTIAL_SHARE, resource, scoring, type PublicIndex } from "./model.ts";
import { subscribeLinks } from "./subscribe.ts";

function scoringSection(ctx: Ctx): HTMLElement {
  const c = scoring.criteria;
  const levelRows = (key: "calle" | "reconocimiento" | "conectividad" | "local"): HTMLElement[] =>
    Object.entries(c[key].levels)
      .sort((a, b) => b[1] - a[1])
      .map(([level, pts]) => h("li", null, h("span", null, ctx.t(`measure.${key}.${level}`)), h("span", { class: "num" }, String(pts))));
  const convRows = c.convocatoria.scale.map((step, i, all) => {
    const prev = all[i - 1];
    const label =
      i === 0
        ? ctx.t("about.attendanceFrom", { n: compactNumber(step.min, ctx.lang) })
        : step.min === 0
          ? ctx.t("about.attendanceBelow", { n: compactNumber(prev?.min ?? 0, ctx.lang) })
          : ctx.t("about.attendanceBetween", { from: compactNumber(step.min, ctx.lang), to: compactNumber(prev?.min ?? 0, ctx.lang) });
    return h("li", null, h("span", null, label), h("span", { class: "num" }, String(step.points)));
  });
  return h(
    "section",
    { class: "section", "aria-labelledby": "how-title" },
    sectionHeading(ctx.t("about.howTitle"), "how-title"),
    h("p", { class: "section__lede" }, ctx.t("about.howBody")),
    h(
      "ol",
      { class: "criteria" },
      CRITERIA.map((key) =>
        h(
          "li",
          { class: "criterion" },
          h("h3", { class: "criterion__name" }, ctx.t(`criterion.${key}`), h("span", { class: "criterion__max num" }, ctx.t("about.max", { max: c[key].max }))),
          h("p", { class: "criterion__desc" }, ctx.t(`about.criterion.${key}`)),
          h("ul", { class: "scale" }, key === "convocatoria" ? convRows : levelRows(key)),
        ),
      ),
    ),
    h(
      "ul",
      { class: "tiers" },
      h("li", null, h("strong", null, ctx.t("tier.1")), " ", ctx.t("about.tier1", { min: scoring.thresholds.tier1 })),
      h("li", null, h("strong", null, ctx.t("tier.2")), " ", ctx.t("about.tier2", { min: scoring.thresholds.tier2, max: scoring.thresholds.tier1 - 1 })),
      h("li", null, h("strong", null, ctx.t("tier.provisional")), " ", ctx.t("about.provisional")),
      h("li", null, ctx.t("about.topN", { count: scoring.country_top_n })),
      h("li", null, ctx.t("about.unmeasured")),
    ),
  );
}

function legendSection(ctx: Ctx): HTMLElement {
  return h(
    "section",
    { class: "section", "aria-labelledby": "marks-title" },
    sectionHeading(ctx.t("about.marksTitle"), "marks-title"),
    h(
      "div",
      { class: "keys" },
      h(
        "ul",
        { class: "key-list", "aria-label": ctx.t("about.statusKey") },
        (["confirmada", "tentativa", "por_anunciar", "aplazada", "cancelada"] as const).map((st) =>
          h("li", null, h("span", { class: "status" }, statusShape(st), ctx.t(`status.${st}`)), h("span", { class: "key-list__desc" }, ctx.t(`about.status.${st}`))),
        ),
      ),
      h(
        "ul",
        { class: "key-list", "aria-label": ctx.t("about.confidenceKey") },
        (["oficial", "prensa", "patron", "estimacion"] as const).map((c) =>
          h("li", null, h("span", { class: "conf" }, confidenceShape(c), ctx.t(`confidence.${c}`)), h("span", { class: "key-list__desc" }, ctx.t(`about.confidence.${c}`))),
        ),
      ),
    ),
  );
}

function freshnessSection(index: PublicIndex, ctx: Ctx): HTMLElement {
  return h(
    "section",
    { class: "section", "aria-labelledby": "fresh-title" },
    sectionHeading(ctx.t("about.freshTitle"), "fresh-title"),
    h("p", { class: "section__lede" }, ctx.t("about.freshBody")),
    h(
      "ul",
      { class: "fresh-list" },
      index.countries.map((c) => {
        const stale = isStale(c.last_verified, ctx.today);
        return h(
          "li",
          { class: `fresh${stale ? " fresh--stale" : ""}` },
          h(
            "div",
            { class: "fresh__head" },
            h("h3", { class: "fresh__name display" }, h("a", { href: ctx.href({ name: "country", code: c.code, query: { tier2: false } }), class: "link" }, countryName(c.code, ctx.lang))),
            h("span", { class: "fresh__count num" }, ctx.t("scope.festivals", { count: c.festivals })),
          ),
          h(
            "p",
            { class: "fresh__when" },
            stale ? icon("alert") : icon("check"),
            c.last_verified
              ? ctx.t(stale ? "about.staleOn" : "fresh.verifiedOn", { when: relativeDays(c.last_verified, ctx.today, ctx.lang), date: shortDate(c.last_verified, ctx.lang) })
              : ctx.t("fresh.never", { country: countryName(c.code, ctx.lang) }),
          ),
          c.share_a < PARTIAL_SHARE
            ? h("p", { class: "fresh__coverage fresh__coverage--partial" }, icon("alert"), ctx.t("fresh.partial", { share: percent(c.share_a, ctx.lang) }))
            : h("p", { class: "fresh__coverage" }, ctx.t("about.coverage", { share: percent(c.share_a, ctx.lang) })),
          h("div", { class: "fresh__sub" }, h("p", { class: "fresh__sublabel" }, ctx.t("subscribe.title", { country: countryName(c.code, ctx.lang) })), subscribeLinks(c.code, ctx)),
        );
      }),
    ),
  );
}

/** Locale text for a key when it exists, else null (t() returns the key itself when missing). */
function known(ctx: Ctx, key: string, params?: Record<string, string | number>): string | null {
  const text = ctx.t(key, params);
  return text === key ? null : text;
}

/** Field ids of the changelog («status», «key_events.<id>», «score.<criterion>[.<part>]») in words. */
function fieldLabel(field: string, festival: Festival | undefined, ctx: Ctx): string {
  const [head = "", id = "", part] = field.split(".");
  if (head === "key_events" && id) {
    const event = Object.values(festival?.editions ?? {})
      .flatMap((e) => e.key_events)
      .find((ev) => ev.id === id);
    return ctx.t("log.field.keyEvent", { name: event ? (event.name[ctx.lang] ?? event.name.es) : id });
  }
  if (head === "score" && id) {
    const criterion = known(ctx, `criterion.${id}`) ?? id;
    return part ? ctx.t("log.field.scorePart", { criterion, part: known(ctx, `log.part.${part}`) ?? part }) : criterion;
  }
  return known(ctx, `log.field.${field}`) ?? field;
}

/** Old and new values in words: enum codes through their locale family, dates and figures formatted. */
function changeValue(v: unknown, field: string, ctx: Ctx): string {
  if (v === null || v === undefined || v === "") return ctx.t("about.changeEmpty");
  const [head = "", id = "", part] = field.split(".");
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return shortDate(v, ctx.lang);
    if (field === "status") return known(ctx, `status.${v}`) ?? v;
    if (field === "confidence" || part === "confidence") return known(ctx, `confidence.${v}`) ?? v;
    if (head === "score" && !part) return known(ctx, `measure.${id}.${v}`) ?? v;
    if (part === "qualifier") return known(ctx, `log.qualifier.${v}`) ?? v;
    if (part === "unit") return known(ctx, `measure.unit.${v}`) ?? v;
    if (/^https:\/\//.test(v)) {
      try {
        return new URL(v).hostname.replace(/^www\./, "");
      } catch {
        return v;
      }
    }
    return v;
  }
  if (typeof v === "number") return part === "year" ? String(v) : fullNumber(v, ctx.lang);
  return JSON.stringify(v);
}

function changelogSection(entries: readonly ChangelogEntry[], festivals: ReadonlyMap<string, Festival>, ctx: Ctx): HTMLElement {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
  return h(
    "section",
    { class: "section", "aria-labelledby": "log-title" },
    sectionHeading(ctx.t("about.logTitle"), "log-title"),
    sorted.length
      ? h(
          "ol",
          { class: "log" },
          sorted.map((e) => {
            const festival = festivals.get(e.slug);
            return h(
              "li",
              { class: "log__item" },
              h("p", { class: "log__date num" }, shortDate(e.date, ctx.lang)),
              h(
                "p",
                { class: "log__what" },
                h("a", { href: ctx.href({ name: "festival", slug: e.slug }), class: "link" }, festival ? festivalName(festival, ctx.lang) : e.slug),
                " ",
                h("span", { class: "log__field" }, fieldLabel(e.field, festival, ctx)),
              ),
              h("p", { class: "log__change num" }, ctx.t("about.change", { old: changeValue(e.old, e.field, ctx), new: changeValue(e.new, e.field, ctx) })),
              h("p", { class: "log__sources" }, e.source_urls.slice(0, 3).map((url, i) => externalLink(url, ctx.t("about.sourceN", { n: i + 1 }), ctx.t, "link link--small"))),
            );
          }),
        )
      : emptyState(ctx.t("about.logEmpty"), ctx.t("about.logEmptyBody"), [{ label: ctx.t("nav.explore"), href: ctx.href({ name: "explore", filters: { countries: [], months: [], types: [], tier2: false, sort: "date" } }) }]),
  );
}

/** R11: travellers can propose a missing festival (GitHub issue form, reviewed monthly). */
function suggestSection(ctx: Ctx): HTMLElement {
  return h(
    "section",
    { class: "section", "aria-labelledby": "suggest-title" },
    sectionHeading(ctx.t("suggest.title"), "suggest-title"),
    h("p", { class: "section__lede" }, ctx.t("suggest.body")),
    actionButton(suggestAction(ctx), "suggest"),
  );
}

export function renderAbout(ctx: Ctx): HTMLElement {
  ctx.title(ctx.t("about.title"));
  const res = resource(`about|${ctx.today}`, async () => {
    const [index, changelog] = await Promise.all([loadIndex(), loadChangelog()]);
    // Festival names for the changelog; a country that fails to load falls back to its slugs.
    const codes = [...new Set(changelog.map((e) => index.slugs[e.slug]).filter((c): c is string => !!c))];
    const files = await Promise.allSettled(codes.map(loadCountry));
    const festivals = new Map<string, Festival>();
    for (const file of files) if (file.status === "fulfilled") for (const f of file.value.festivals) festivals.set(f.slug, f);
    return { index, changelog, festivals };
  });
  return h(
    "div",
    { class: "screen screen--about" },
    h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("about.title")),
    h("p", { class: "screen-lede" }, ctx.t("about.lede")),
    scoringSection(ctx),
    legendSection(ctx),
    asyncView(res, "list", ctx, ({ index, changelog, festivals }) => [freshnessSection(index, ctx), changelogSection(changelog, festivals, ctx), suggestSection(ctx)]),
  );
}
