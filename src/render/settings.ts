// Ajustes (RF-11, RF-14, R6): language, origin country for travel advisories, first day of the
// week and the optional «Cerca de mí». The location is asked only after an explicit tap and
// stays in memory on this device.
import { h } from "../h.ts";
import { LANGS } from "../i18n.ts";
import type { Lang } from "../schema.ts";
import { countryItems } from "../search.ts";
import type { WeekStart } from "../store.ts";
import { countryName } from "../ics.ts";
import { notice } from "./components.ts";
import type { Ctx } from "./context.ts";
import { icon } from "./icons.ts";
import { coveredOrigins } from "./model.ts";

/** «Canadá, España y Reino Unido»: the origins with a verified official advisory link. */
function coveredList(ctx: Ctx): string {
  const names = coveredOrigins()
    .map((code) => countryName(code, ctx.lang))
    .sort((a, b) => a.localeCompare(b, ctx.lang));
  return new Intl.ListFormat(ctx.lang, { type: "conjunction" }).format(names);
}

function radioGroup<T extends string | number>(
  name: string,
  legend: string,
  options: readonly { value: T; label: string; lang?: string }[],
  current: T,
  onChange: (v: T) => void,
  hint?: string,
): HTMLElement {
  return h(
    "fieldset",
    { class: "setting" },
    h("legend", { class: "setting__legend display" }, legend),
    hint ? h("p", { class: "setting__hint", id: `${name}-hint` }, hint) : null,
    h(
      "div",
      { class: "radios" },
      options.map((o) => {
        const id = `${name}-${o.value}`;
        const input = h("input", { type: "radio", name, id, value: String(o.value), checked: o.value === current, "data-key": id, "aria-describedby": hint ? `${name}-hint` : null });
        input.addEventListener("change", () => {
          if (input.checked) onChange(o.value);
        });
        return h("label", { class: "radio", for: id }, input, h("span", { class: "radio__mark", "aria-hidden": "true" }), h("span", { lang: o.lang ?? null }, o.label));
      }),
    ),
  );
}

function nearBlock(ctx: Ctx): HTMLElement {
  const geo = ctx.geo();
  const body: (HTMLElement | null)[] = [];
  if (geo.status === "on") {
    body.push(
      h("p", { class: "setting__state", role: "status" }, icon("check"), ctx.t("near.on")),
      h("div", { class: "setting__actions" }, h("a", { class: "btn btn--primary", href: ctx.href({ name: "explore", filters: { countries: [], months: [], types: [], tier2: false, sort: "near" } }) }, ctx.t("near.see")), h("button", { type: "button", class: "btn btn--secondary", "data-key": "geo-forget", onclick: () => ctx.forgetGeo() }, ctx.t("near.forget"))),
    );
  } else {
    if (geo.status === "denied") body.push(notice("info", "alert", h("p", null, ctx.t("near.denied"))));
    if (geo.status === "unavailable") body.push(notice("info", "alert", h("p", null, ctx.t("near.unavailable"))));
    body.push(
      h(
        "button",
        { type: "button", class: "btn btn--primary", "data-key": "geo-enable", disabled: geo.status === "asking", "aria-busy": geo.status === "asking" ? "true" : null, onclick: () => ctx.requestGeo() },
        icon("pin"),
        ctx.t(geo.status === "asking" ? "near.asking" : "near.enable"),
      ),
    );
  }
  return h("section", { class: "setting", "aria-labelledby": "near-title" }, h("h2", { class: "setting__legend display", id: "near-title" }, ctx.t("near.title")), h("p", { class: "setting__hint" }, ctx.t("near.privacy")), ...body);
}

export function renderSettings(ctx: Ctx): HTMLElement {
  ctx.title(ctx.t("settings.title"));
  const langNames: Record<Lang, string> = { es: ctx.t("lang.es"), en: ctx.t("lang.en"), pt: ctx.t("lang.pt") };

  const origin = ctx.store.get("origin");
  const select = h("select", { id: "origin", class: "select", "data-key": "origin", "aria-describedby": "origin-hint" });
  select.append(h("option", { value: "" }, ctx.t("settings.originNone")));
  for (const c of countryItems(ctx.lang)) select.append(h("option", { value: c.code, selected: c.code === origin }, c.name));
  select.addEventListener("change", () => {
    ctx.store.set("origin", select.value || null);
    ctx.announce(ctx.t("settings.saved"));
  });

  const weekOptions: { value: WeekStart; label: string }[] = [
    { value: 1, label: ctx.t("settings.weekMonday") },
    { value: 7, label: ctx.t("settings.weekSunday") },
    { value: 6, label: ctx.t("settings.weekSaturday") },
  ];

  return h(
    "div",
    { class: "screen screen--settings" },
    h("h1", { class: "screen-title display", tabindex: "-1" }, ctx.t("settings.title")),
    ctx.store.persistent() ? null : notice("warn", "alert", h("p", null, ctx.t("saved.notPersistent"))),
    h(
      "div",
      { class: "settings" },
      radioGroup<Lang>(
        "lang",
        ctx.t("settings.language"),
        LANGS.map((l) => ({ value: l, label: langNames[l], lang: l })),
        ctx.lang,
        (v) => ctx.store.set("lang", v),
      ),
      h(
        "div",
        { class: "setting" },
        h("label", { for: "origin", class: "setting__legend display" }, ctx.t("settings.origin")),
        h("p", { class: "setting__hint", id: "origin-hint" }, ctx.t("settings.originHint"), " ", ctx.t("settings.originCovered", { countries: coveredList(ctx) })),
        h("div", { class: "select-wrap" }, select, icon("chevronDown")),
      ),
      radioGroup<WeekStart>("week", ctx.t("settings.weekStart"), weekOptions, ctx.weekStart, (v) => {
        ctx.store.set("weekStart", v);
        ctx.announce(ctx.t("settings.saved"));
      }),
      nearBlock(ctx),
      h("p", { class: "settings__about" }, h("a", { class: "link", href: ctx.href({ name: "about" }) }, ctx.t("about.title"))),
    ),
  );
}
