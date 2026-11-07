// «Agregar al calendario» (RF-10): tap 1 opens the sheet, tap 2 adds to Google, Apple (.ics) or
// Outlook. Unconfirmed events carry «[Por confirmar]» in the title (ics.ts enforces it).
import type { FestivalEntry } from "../festivals.ts";
import { h } from "../h.ts";
import { buildCalendar, countryName, eventFor, formatDtstamp, googleCalendarUrl, outlookCalendarUrl, type IcsEvent } from "../ics.ts";
import { externalLink, festivalName } from "./components.ts";
import type { Ctx } from "./context.ts";
import { icon } from "./icons.ts";
import { openSheet } from "./sheet.ts";
import { subscribeLinks } from "./subscribe.ts";

export function downloadFile(filename: string, content: string, type = "text/calendar;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename, class: "sr-only" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function eventOf(entry: FestivalEntry, ctx: Ctx): IcsEvent | null {
  return eventFor(entry, ctx.lang, ctx.t, ctx.siteUrl);
}

export function icsFor(events: readonly IcsEvent[], name: string): string {
  return buildCalendar(events, { name, dtstamp: formatDtstamp(new Date()) });
}

function prefixKey(entry: FestivalEntry): string {
  const status = entry.occurrence?.status;
  if (status === "cancelada") return "ics.prefix.cancelled";
  if (status === "aplazada") return "ics.prefix.postponed";
  return "ics.prefix.tentative";
}

export function openCalendarSheet(entry: FestivalEntry, ctx: Ctx): void {
  const event = eventOf(entry, ctx);
  const name = festivalName(entry.festival, ctx.lang);
  const year = entry.occurrence?.year ?? "";
  openSheet({
    id: "calendar-sheet",
    title: ctx.t("calendar.title"),
    closeLabel: ctx.t("sheet.close"),
    body: (close) => {
      if (!event) {
        return [
          h("p", { class: "sheet__lede" }, ctx.t("calendar.noDate", { name })),
          h("p", { class: "sheet__lede" }, ctx.t("calendar.noDateSubscribe", { country: countryName(entry.country, ctx.lang) })),
          subscribeLinks(entry.country, ctx),
        ];
      }
      const unconfirmed = event.status !== "CONFIRMED";
      return [
        h("p", { class: "sheet__lede" }, h("strong", null, event.summary)),
        h("h3", { class: "scope__group sheet__group" }, ctx.t("calendar.thisOne")),
        h(
          "ul",
          { class: "options options--cal" },
          h("li", null, externalLink(googleCalendarUrl(event), h("span", { class: "option__label" }, ctx.t("calendar.google")), ctx.t, "option")),
          h(
            "li",
            null,
            h(
              "button",
              {
                type: "button",
                class: "option",
                "data-testid": "ics-download",
                onclick: () => {
                  downloadFile(`${entry.festival.slug}-${year}.ics`, icsFor([event], name));
                  ctx.announce(ctx.t("calendar.downloaded"));
                  close();
                },
              },
              h("span", { class: "option__label" }, ctx.t("calendar.apple")),
              h("span", { class: "option__detail" }, ctx.t("calendar.appleDetail")),
              icon("download"),
            ),
          ),
          h("li", null, externalLink(outlookCalendarUrl(event), h("span", { class: "option__label" }, ctx.t("calendar.outlook")), ctx.t, "option")),
        ),
        unconfirmed ? h("p", { class: "sheet__note" }, ctx.t("calendar.unconfirmedNote", { prefix: ctx.t(prefixKey(entry)) })) : null,
        h("h3", { class: "scope__group sheet__group" }, ctx.t("calendar.subscribeTitle", { country: countryName(entry.country, ctx.lang) })),
        h("p", { class: "sheet__note" }, ctx.t("subscribe.body")),
        subscribeLinks(entry.country, ctx),
      ];
    },
  });
}
