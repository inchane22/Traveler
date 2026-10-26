// Small month grid for an edition, starting the week on the day chosen in Ajustes. A visual aid:
// the dates are already given as text, so the grid is hidden from assistive technology.
import { addDays, addMonths, weekday, type ISO } from "../dates.ts";
import { h } from "../h.ts";
import type { Ctx } from "./context.ts";
import { monthLabel, weekdayHeaders } from "./format.ts";

export interface GridMark {
  start: ISO;
  end: ISO;
  /** solid = confirmed, hatched = not confirmed, window = probable window only */
  mod: "solid" | "hatched" | "window";
}

const MAX_MONTHS = 2;

function monthTable(first: ISO, mark: GridMark, events: ReadonlySet<ISO>, weekStart: number, ctx: Ctx): HTMLElement {
  const headers = weekdayHeaders(ctx.lang, weekStart);
  const startDow = weekStart % 7;
  const lead = (weekday(first) - startDow + 7) % 7;
  const nextMonth = addMonths(first, 1);
  const cells: HTMLElement[] = [];
  for (let i = 0; i < lead; i++) cells.push(h("span", { class: "mg-day mg-day--pad" }));
  for (let d = first; d < nextMonth; d = addDays(d, 1)) {
    const inRange = d >= mark.start && d <= mark.end;
    const cls = [
      "mg-day num",
      inRange ? `mg-day--in band--${mark.mod}` : "",
      inRange && d === mark.start ? "mg-day--first" : "",
      inRange && d === mark.end ? "mg-day--last" : "",
      d === ctx.today ? "mg-day--today" : "",
      events.has(d) ? "mg-day--event" : "",
    ].filter(Boolean);
    cells.push(h("span", { class: cls.join(" ") }, String(Number(d.slice(8)))));
  }
  return h(
    "div",
    { class: "mg-month" },
    h("p", { class: "mg-title" }, monthLabel(first, ctx.lang)),
    h(
      "div",
      { class: "mg-grid" },
      headers.map((w) => h("span", { class: "mg-head" }, w.narrow)),
      cells,
    ),
  );
}

export function monthGrid(mark: GridMark, eventDates: readonly ISO[], ctx: Ctx): HTMLElement {
  const weekStart = ctx.weekStart;
  const months: ISO[] = [];
  for (let m = `${mark.start.slice(0, 7)}-01`; m <= mark.end && months.length < MAX_MONTHS; m = addMonths(m, 1)) months.push(m);
  const events = new Set(eventDates.filter((d) => months.some((m) => d.startsWith(m.slice(0, 7)))));
  return h("div", { class: "month-grid", "aria-hidden": "true" }, months.map((m) => monthTable(m, mark, events, weekStart, ctx)));
}
