// Country subscription (RF-10): webcal feed for Apple Calendar and Outlook desktop, plus Google and
// Outlook.com «add by URL» links. The feed file follows the UI language.
import { h, srOnly } from "../h.ts";
import { calendarPath, countryName, webcalUrl } from "../ics.ts";
import { externalLink, sectionHeading } from "./components.ts";
import type { Ctx } from "./context.ts";
import { icon } from "./icons.ts";

export function feedUrls(code: string, ctx: Ctx): { webcal: string; https: string; google: string; outlook: string } {
  const https = `${ctx.siteUrl}${calendarPath(code, ctx.lang)}`;
  const webcal = webcalUrl(ctx.siteUrl, code, ctx.lang);
  const name = ctx.t("ics.calendarName", { country: countryName(code, ctx.lang) });
  return {
    webcal,
    https,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(name)}`,
  };
}

export function subscribeLinks(code: string, ctx: Ctx): HTMLElement {
  const urls = feedUrls(code, ctx);
  return h(
    "ul",
    { class: "subscribe__links" },
    h("li", null, h("a", { href: urls.webcal, class: "btn btn--primary", "data-key": `sub-webcal-${code}` }, icon("rss"), srOnly(`${ctx.t("subscribe.srPrefix")} `), ctx.t("subscribe.webcal"))),
    h("li", null, externalLink(urls.google, [srOnly(`${ctx.t("subscribe.srPrefix")} `), ctx.t("subscribe.google")], ctx.t, "btn btn--secondary")),
    h("li", null, externalLink(urls.outlook, [srOnly(`${ctx.t("subscribe.srPrefix")} `), ctx.t("subscribe.outlook")], ctx.t, "btn btn--secondary")),
  );
}

export function subscribeBlock(code: string, ctx: Ctx, level: "h2" | "h3" = "h2"): HTMLElement {
  const id = `subscribe-${code.toLowerCase()}`;
  return h(
    "section",
    { class: "section subscribe", "aria-labelledby": id },
    sectionHeading(ctx.t("subscribe.title", { country: countryName(code, ctx.lang) }), id, level),
    h("p", { class: "section__lede" }, ctx.t("subscribe.body")),
    subscribeLinks(code, ctx),
  );
}
