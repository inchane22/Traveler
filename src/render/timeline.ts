// RF-05: rolling 12-month timeline. Each bar sits in a list row whose link carries the name,
// dates and status as text, so screen readers get the list; the graphic parts are aria-hidden.
// Encoding: color = festival type (with a legend and the type in each row's text), solid = confirmed,
// hatched = not confirmed, outline = probable window only, struck = cancelled.
import { addMonths, diffDays, type ISO } from "../dates.ts";
import type { FilterHit } from "../festivals.ts";
import { h } from "../h.ts";
import type { FestivalType } from "../schema.ts";
import { festivalName, occurrenceDates } from "./components.ts";
import type { Ctx } from "./context.ts";
import { monthShort } from "./format.ts";
import { dateKind, hitSpan, isUnconfirmed, timelineDomain } from "./model.ts";

const pct = (n: number): string => `${Math.max(0, Math.min(100, n)).toFixed(3)}%`;

function barMod(hit: FilterHit): string {
  if (hit.occurrence.status === "cancelada") return "cancelled";
  const kind = dateKind(hit.occurrence);
  if (kind !== "dated") return "window";
  return isUnconfirmed(hit.occurrence) ? "hatched" : "solid";
}

export function legend(types: readonly FestivalType[], ctx: Ctx, withPatterns = true): HTMLElement {
  return h(
    "div",
    { class: "legend" },
    h(
      "ul",
      { class: "legend__types", "aria-label": ctx.t("timeline.legendTypes") },
      types.map((type) => h("li", { class: `legend__item type--${type}` }, h("span", { class: "legend__bar bar band--solid", "aria-hidden": "true" }), ctx.t(`type.${type}`))),
    ),
    withPatterns
      ? h(
          "ul",
          { class: "legend__patterns", "aria-label": ctx.t("timeline.legendPatterns") },
          (["solid", "hatched", "window"] as const).map((mod) =>
            h("li", { class: "legend__item legend__item--ink" }, h("span", { class: `legend__bar bar band--${mod}`, "aria-hidden": "true" }), ctx.t(`timeline.pattern.${mod}`)),
          ),
        )
      : null,
  );
}

export function timeline(hits: readonly FilterHit[], ctx: Ctx): HTMLElement {
  const { start, end } = timelineDomain(ctx.today);
  const total = diffDays(start, end);
  const x = (iso: ISO): number => (diffDays(start, iso) / total) * 100;

  const months = Array.from({ length: 12 }, (_, i) => addMonths(start, i));
  const axis = h(
    "div",
    { class: "tl-axis", "aria-hidden": "true" },
    months.map((m, i) =>
      h(
        "span",
        { class: `tl-month${m.endsWith("-01-01") || i === 0 ? " tl-month--year" : ""}`, style: { "--x": pct(x(m)), "--w": pct(x(addMonths(m, 1)) - x(m)) } },
        h("span", { class: "tl-month__name" }, monthShort(m, ctx.lang).slice(0, 3)),
        m.endsWith("-01-01") || i === 0 ? h("span", { class: "tl-month__year num" }, m.slice(0, 4)) : null,
      ),
    ),
  );

  const grid = h(
    "div",
    { class: "tl-grid", "aria-hidden": "true" },
    months.slice(1).map((m) => h("span", { class: "tl-gridline", style: { "--x": pct(x(m)) } })),
    h("span", { class: "tl-today", style: { "--x": pct(x(ctx.today)) } }, h("span", { class: "tl-today__label" }, ctx.t("timeline.today"))),
  );

  const rows = h(
    "ol",
    { class: "tl-rows" },
    hits.map((hit) => {
      const f = hit.entry.festival;
      const span = hitSpan(hit);
      const s0 = span.start < start ? start : span.start;
      const s1 = span.end >= end ? end : span.end;
      const left = x(s0);
      const width = ((diffDays(s0, s1) + 1) / total) * 100;
      const mod = barMod(hit);
      const cancelled = hit.occurrence.status === "cancelada";
      return h(
        "li",
        { class: `tl-row type--${f.type}${cancelled ? " is-cancelled" : ""}` },
        h(
          "div",
          { class: "tl-row__label" },
          h(
            "a",
            { href: ctx.href({ name: "festival", slug: f.slug }), class: "tl-row__name", "data-key": `tl-${f.slug}` },
            festivalName(f, ctx.lang),
            h("span", { class: "sr-only" }, `, ${ctx.t(`type.${f.type}`)}, ${occurrenceDates(hit.occurrence, ctx.lang, ctx.t)}, ${ctx.t(`status.${hit.occurrence.status}`)}`),
          ),
          h("span", { class: "tl-row__date num", "aria-hidden": "true" }, occurrenceDates(hit.occurrence, ctx.lang, ctx.t, false)),
        ),
        h("div", { class: "tl-track", "aria-hidden": "true" }, h("span", { class: `tl-bar bar band--${mod}`, style: { "--x": pct(left), "--w": pct(width) } })),
      );
    }),
  );

  return h("div", { class: "timeline" }, axis, h("div", { class: "tl-body" }, grid, rows));
}
