// Sobre los datos (#/datos, RF-13): how the score is computed (config/scoring.json), freshness per
// country, subscriptions and the changelog of approved changes.
import { h } from "../h.ts";
import { countryName } from "../ics.ts";
import type { ChangelogEntry } from "../schema.ts";
import { CRITERIA } from "../score.ts";
import { asyncView, confidenceShape, emptyState, externalLink, sectionHeading, statusShape } from "./components.ts";
import type { Ctx } from "./context.ts";
import { compactNumber, percent, relativeDays, shortDate } from "./format.ts";
import { icon } from "./icons.ts";
import { isStale, loadChangelog, loadIndex, PARTIAL_SHARE, resource, scoring, type PublicIndex } from "./model.ts";
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

function changeValue(v: unknown, ctx: Ctx): string {
  if (v === null || v === undefined || v === "") return ctx.t("about.changeEmpty");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return shortDate(v, ctx.lang);
  return typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v);
}

function changelogSection(entries: readonly ChangelogEntry[], ctx: Ctx): HTMLElement {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
  return h(
    "section",
    { class: "section", "aria-labelledby": "log-title" },
    sectionHeading(ctx.t("about.logTitle"), "log-title"),
    sorted.length
      ? h(
          "ol",
          { class: "log" },
          sorted.map((e) =>
            h(
              "li",
              { class: "log__item" },
              h("p", { class: "log__date num" }, shortDate(e.date, ctx.lang)),
              h(
                "p",
                { class: "log__what" },
                h("a", { href: ctx.href({ name: "festival", slug: e.slug }), class: "link" }, e.slug),
                " ",
                h("span", { class: "log__field" }, e.field),
              ),
              h("p", { class: "log__change num" }, ctx.t("about.change", { old: changeValue(e.old, ctx), new: changeValue(e.new, ctx) })),
              h("p", { class: "log__sources" }, e.source_urls.slice(0, 3).map((url, i) => externalLink(url, ctx.t("about.sourceN", { n: i + 1 }), ctx.t, "link link--small"))),
            ),
          ),
        )
      : emptyState(ctx.t("about.logEmpty"), ctx.t("about.logEmptyBody"), [{ label: ctx.t("nav.explore"), href: ctx.href({ name: "explore", filters: { countries: [], months: [], types: [], tier2: false, sort: "date" } }) }]),
  );
}

export function renderAbout(ctx: Ctx): HTMLElement {
  ctx.title(ctx.t("about.title"));
  const res = resource(`about|${ctx.today}`, async () => {
    const [index, changelog] = await Promise.all([loadIndex(), loadChangelog()]);
    return { index, changelog };
  });
  return h(
    "div",
    { class: "screen screen--about" },
    h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("about.title")),
    h("p", { class: "screen-lede" }, ctx.t("about.lede")),
    scoringSection(ctx),
    legendSection(ctx),
    asyncView(res, "list", ctx, ({ index, changelog }) => [freshnessSection(index, ctx), changelogSection(changelog, ctx)]),
  );
}
