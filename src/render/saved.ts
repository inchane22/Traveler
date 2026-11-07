// Guardadas (RF-09): saved festivals by date, all exportable to one .ics.
import { h } from "../h.ts";
import type { IcsEvent } from "../ics.ts";
import { EMPTY_FILTERS } from "../router.ts";
import { downloadFile, eventOf, icsFor } from "./calendar.ts";
import {
  asyncView,
  countdownText,
  dateBand,
  emptyState,
  festivalName,
  notice,
  occurrenceDates,
  placeLine,
  saveButton,
  trustMark,
  typeTag,
} from "./components.ts";
import type { Ctx } from "./context.ts";
import { icon } from "./icons.ts";
import { countdown, loadSaved, resource } from "./model.ts";
import { dayNumber, monthShort } from "./format.ts";
import { effectiveStart } from "../dates.ts";

export function renderSaved(ctx: Ctx): HTMLElement {
  ctx.title(ctx.t("saved.title"));
  const slugs = ctx.store.get("saved");
  const head = h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("saved.title"));
  const storageNote = ctx.store.persistent() ? null : notice("warn", "alert", h("p", null, ctx.t("saved.notPersistent")));

  if (!slugs.length) {
    return h(
      "div",
      { class: "screen screen--saved" },
      head,
      storageNote,
      emptyState(ctx.t("saved.emptyTitle"), ctx.t("saved.emptyBody"), [
        { label: ctx.t("saved.emptyExplore"), href: ctx.href({ name: "explore", filters: { ...EMPTY_FILTERS } }), primary: true },
        { label: ctx.t("nav.home"), href: ctx.href({ name: "home", query: { tier2: false } }) },
      ]),
    );
  }

  const res = resource(`saved|${slugs.join(",")}|${ctx.today}`, () => loadSaved(slugs, ctx.today));
  return h(
    "div",
    { class: "screen screen--saved" },
    head,
    storageNote,
    asyncView(res, "list", ctx, ({ entries, missing }) => {
      const events = entries.map((e) => eventOf(e, ctx)).filter((e): e is IcsEvent => e !== null);
      const undated = entries.length - events.length;
      return [
        h(
          "div",
          { class: "saved-head" },
          h("p", { class: "saved-head__count", "data-testid": "saved-count" }, ctx.t("saved.count", { count: entries.length })),
          h(
            "button",
            {
              type: "button",
              class: "btn btn--primary",
              "data-key": "export-all",
              disabled: !events.length,
              onclick: () => {
                downloadFile("traveler-guardadas.ics", icsFor(events, ctx.t("saved.calendarName")));
                ctx.announce(ctx.t("calendar.downloaded"));
              },
            },
            icon("download"),
            ctx.t("saved.exportAll"),
          ),
        ),
        undated ? h("p", { class: "section__lede" }, ctx.t("saved.undated", { count: undated })) : null,
        missing.length ? notice("info", "alert", h("p", null, ctx.t("saved.missing", { count: missing.length }))) : null,
        h(
          "ul",
          { class: "fest-list", "data-testid": "saved-list" },
          entries.map((e) => {
            const f = e.festival;
            const occ = e.occurrence;
            const start = occ ? effectiveStart(occ) : null;
            return h(
              "li",
              { class: `fest-row type--${f.type}${occ?.status === "cancelada" ? " is-cancelled" : ""}`, "data-slug": f.slug },
              h(
                "div",
                { class: "stub", "aria-hidden": "true" },
                h("span", { class: "stub__day num" }, occ?.start && start ? dayNumber(start) : "≈"),
                h("span", { class: "stub__month" }, start ? monthShort(start, ctx.lang) : ""),
                dateBand(occ, f.type),
              ),
              h(
                "div",
                { class: "fest-row__main" },
                h("h2", { class: "fest-row__name display" }, h("a", { href: ctx.href({ name: "festival", slug: f.slug }), class: "stretched", "data-key": `saved-${f.slug}` }, festivalName(f, ctx.lang))),
                h("p", { class: "fest-row__when" }, h("span", { class: "num" }, occurrenceDates(occ, ctx.lang, ctx.t)), h("span", { class: "fest-row__place" }, placeLine(e, ctx.lang))),
                h(
                  "p",
                  { class: "marks" },
                  typeTag(f.type, ctx.t),
                  occ ? trustMark(occ, ctx.t) : null,
                  h("span", { class: "tag num" }, countdownText(countdown(occ, ctx.today), ctx.t)),
                ),
              ),
              saveButton(e, ctx),
            );
          }),
        ),
      ];
    }),
  );
}
