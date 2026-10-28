// Shared pieces: type tags, status and confidence marks (shape + text, never color alone),
// date bands, countdowns, save toggles, notices and empty states.
import type { Occurrence } from "../dates.ts";
import { isPendingPostponement, type FestivalEntry } from "../festivals.ts";
import { h, s, type Child } from "../h.ts";
import { countryName } from "../ics.ts";
import type { Confidence, Festival, FestivalType, Lang, Status } from "../schema.ts";
import type { Ctx } from "./context.ts";
import { range, relativeDays, shortDate } from "./format.ts";
import { icon, type IconName } from "./icons.ts";
import { clearFailed, countdown, DataError, dateKind, isStale, isUnconfirmed, type Countdown, type IndexCountry, type Resource } from "./model.ts";

export function festivalName(f: Festival, lang: Lang): string {
  return f.names[lang];
}

export function placeLine(entry: { festival: Festival; country: string }, lang: Lang): string {
  return `${entry.festival.city}, ${countryName(entry.country, lang)}`;
}

/** Type color is a mark (swatch) beside an ink label: color never carries meaning alone. */
export function typeTag(type: FestivalType, t: Ctx["t"]): HTMLElement {
  return h("span", { class: `type-tag type--${type}` }, h("span", { class: "swatch", "aria-hidden": "true" }), t(`type.${type}`));
}

const STATUS_SHAPES: Record<Status, (string | [string, Record<string, string>])[]> = {
  confirmada: [["rect", { x: "1.5", y: "1.5", width: "11", height: "11", class: "shape-fill" }]],
  tentativa: [
    ["rect", { x: "1.5", y: "1.5", width: "11", height: "11", class: "shape-stroke" }],
    ["path", { d: "M1.5 8.5l7-7M5.5 12.5l7-7M1.5 12.5l11-11", class: "shape-stroke shape-thin" }],
  ],
  por_anunciar: [["rect", { x: "1.5", y: "1.5", width: "11", height: "11", class: "shape-stroke shape-dashed" }]],
  aplazada: [
    ["rect", { x: "1.5", y: "1.5", width: "11", height: "11", class: "shape-stroke" }],
    ["path", { d: "M1.5 12.5V1.5h5.5v11z", class: "shape-fill" }],
  ],
  cancelada: [
    ["rect", { x: "1.5", y: "1.5", width: "11", height: "11", class: "shape-stroke" }],
    ["path", { d: "M4 4l6 6M10 4l-6 6", class: "shape-stroke" }],
  ],
};

export function statusShape(status: Status): SVGElement {
  return s(
    "svg",
    { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": "true", focusable: "false", class: "status-shape" },
    STATUS_SHAPES[status].map((part) => (typeof part === "string" ? s(part) : s(part[0], part[1]))),
  );
}

export function statusBadge(status: Status, t: Ctx["t"]): HTMLElement {
  return h("span", { class: `status status--${status}` }, statusShape(status), t(`status.${status}`));
}

const CONF_SHAPES: Record<Confidence, Record<string, string>> = {
  oficial: { cx: "7", cy: "7", r: "5.5", class: "shape-fill" },
  prensa: { cx: "7", cy: "7", r: "5", class: "shape-stroke" },
  patron: { cx: "7", cy: "7", r: "5", class: "shape-stroke shape-dashed-ring" },
  estimacion: { cx: "7", cy: "7", r: "5", class: "shape-stroke shape-dotted-ring" },
};

export function confidenceShape(c: Confidence): SVGElement {
  return s(
    "svg",
    { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": "true", focusable: "false", class: "conf-shape" },
    s("circle", CONF_SHAPES[c]),
  );
}

/** «● Oficial»: the label is always visible next to its shape (RF-08). */
export function confidenceMark(c: Confidence, t: Ctx["t"], withPrefix = false): HTMLElement {
  return h(
    "span",
    { class: `conf conf--${c}` },
    confidenceShape(c),
    withPrefix ? t("confidence.labelled", { confidence: t(`confidence.${c}`) }) : t(`confidence.${c}`),
  );
}

/** Solid = confirmed, hatched = not confirmed, outline = only a probable window (same code as the timeline). */
export function bandMod(occ: Occurrence | null): "solid" | "hatched" | "window" {
  const kind = dateKind(occ);
  return kind === "window" || kind === "none" ? "window" : isUnconfirmed(occ) ? "hatched" : "solid";
}

export function dateBand(occ: Occurrence | null, type: FestivalType): HTMLElement {
  return h("span", { class: `band band--${bandMod(occ)} type--${type}`, "aria-hidden": "true" });
}

/** Poster band (hero, ficha header): the wide band carries the same date code as rows and the timeline. */
export function posterBand(occ: Occurrence | null): HTMLElement {
  return h("span", { class: `poster__band band--${bandMod(occ)}`, "aria-hidden": "true" });
}

export function occurrenceDates(occ: Occurrence | null, lang: Lang, t: Ctx["t"], withYear = true): string {
  if (occ?.start && occ.end) return range(occ.start, occ.end, lang, withYear);
  if (occ?.window && isPendingPostponement(occ)) return t("date.originalWindow", { range: range(occ.window.start, occ.window.end, lang, withYear) });
  if (occ?.window) return t("date.window", { range: range(occ.window.start, occ.window.end, lang, withYear) });
  return t("date.unknown");
}

export function countdownText(cd: Countdown, t: Ctx["t"]): string {
  switch (cd.kind) {
    case "days":
      if (cd.approx) return t(cd.days === 0 ? "countdown.windowOpen" : "countdown.approx", { count: cd.days });
      return cd.days === 1 ? t("countdown.tomorrow") : t("countdown.in", { count: cd.days });
    case "today":
      return t("countdown.today");
    case "ongoing":
      return cd.daysLeft === 0 ? t("countdown.lastDay") : t("countdown.ongoing", { count: cd.daysLeft });
    case "ended":
      return t("countdown.ended");
    case "postponed":
      return t("countdown.postponed");
    case "unknown":
      return t("countdown.unknown");
  }
}

/** Big countdown: «Empieza en / 15 / días». The full sentence is the accessible text. */
export function countdownBlock(occ: Occurrence | null, ctx: Ctx): HTMLElement {
  const cd = countdown(occ, ctx.today);
  const sentence = countdownText(cd, ctx.t);
  if (cd.kind === "days" && cd.days > 0) {
    return h(
      "p",
      { class: "countdown", "data-countdown": "" },
      h("span", { class: "sr-only" }, sentence),
      h(
        "span",
        { class: "countdown__visual", "aria-hidden": "true" },
        h("span", { class: "countdown__label" }, ctx.t(cd.approx ? "countdown.approxLabel" : "countdown.startsIn")),
        h("span", { class: "countdown__number num" }, String(cd.days)),
        h("span", { class: "countdown__unit" }, ctx.t("countdown.unit", { count: cd.days })),
      ),
    );
  }
  return h("p", { class: "countdown countdown--word", "data-countdown": "" }, h("span", { class: "countdown__word" }, sentence));
}

/** RF-19: moon-dependent dates are estimates until officially announced. */
export function moonNote(occ: Occurrence | null, t: Ctx["t"]): HTMLElement | null {
  return occ?.estimated ? h("p", { class: "moon-note" }, t("date.moonEstimate")) : null;
}

export function saveButton(entry: FestivalEntry, ctx: Ctx, variant: "icon" | "full" = "icon"): HTMLButtonElement {
  const slug = entry.festival.slug;
  const name = festivalName(entry.festival, ctx.lang);
  const btn = h("button", { type: "button", class: `save save--${variant}`, "data-key": `save-${slug}-${variant}` });
  const paint = (): void => {
    const saved = ctx.store.isSaved(slug);
    btn.setAttribute("aria-pressed", String(saved));
    btn.replaceChildren(
      icon("saved", saved),
      variant === "full" ? h("span", null, ctx.t(saved ? "save.saved" : "save.save")) : h("span", { class: "sr-only" }, ctx.t("save.saveNamed", { name })),
    );
  };
  paint();
  btn.addEventListener("click", () => {
    const now = ctx.store.toggleSaved(slug);
    paint();
    btn.classList.remove("save--pop");
    void btn.offsetWidth;
    btn.classList.add("save--pop");
    ctx.announce(ctx.t(now ? "save.announceSaved" : "save.announceRemoved", { name }));
  });
  return btn;
}

export function notice(kind: "info" | "warn" | "draft" | "offline" | "cancel", iconName: IconName, ...children: Child[]): HTMLElement {
  return h("div", { class: `notice notice--${kind}`, role: kind === "offline" ? "status" : null }, icon(iconName), h("div", { class: "notice__body" }, ...children));
}

export interface EmptyAction {
  label: string;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
  /** External https link: opens in a new tab and says so with this screen-reader text. */
  newTab?: string;
}

export function actionButton(a: EmptyAction, key?: string): HTMLElement {
  const cls = `btn ${a.primary ? "btn--primary" : "btn--secondary"}`;
  if (a.href && a.newTab) return h("a", { class: `${cls} link--external`, href: a.href, external: true, "data-key": key ?? null }, a.label, h("span", { class: "sr-only" }, ` ${a.newTab}`), icon("external"));
  if (a.href) return h("a", { class: cls, href: a.href, "data-key": key ?? null }, a.label);
  return h("button", { type: "button", class: cls, onclick: () => a.onClick?.(), "data-key": key ?? null }, a.label);
}

/** Every empty state says what happened and offers at least one way forward. */
export function emptyState(title: string, body: string | null, actions: EmptyAction[]): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty__title display" }, title),
    body ? h("p", { class: "empty__body" }, body) : null,
    actions.length ? h("div", { class: "empty__actions" }, actions.map((a, i) => actionButton(a, `empty-${i}`))) : null,
  );
}

export function sectionHeading(text: string, id?: string, level: "h2" | "h3" = "h2"): HTMLElement {
  return h(level, { class: "section-title display", id: id ?? null }, text);
}

export function skeleton(kind: "home" | "list" | "detail"): HTMLElement {
  const blocks: Child[] =
    kind === "home"
      ? [h("div", { class: "skel skel--title" }), h("div", { class: "skel skel--hero" }), h("div", { class: "skel skel--row" }), h("div", { class: "skel skel--row" })]
      : kind === "detail"
        ? [h("div", { class: "skel skel--title" }), h("div", { class: "skel skel--hero skel--short" }), h("div", { class: "skel skel--row" })]
        : [h("div", { class: "skel skel--title" }), h("div", { class: "skel skel--chips" }), h("div", { class: "skel skel--row" }), h("div", { class: "skel skel--row" }), h("div", { class: "skel skel--row" })];
  return h("div", { class: "skeleton", "aria-hidden": "true" }, blocks);
}

/** https only, new tab, rel=noopener noreferrer (h() enforces it); says so to screen readers. */
export function externalLink(href: string, label: Child, t: Ctx["t"], cls = "link"): HTMLElement {
  return h("a", { href, external: true, class: `${cls} link--external` }, label, h("span", { class: "sr-only" }, ` ${t("link.newTab")}`), icon("external"));
}

/** GitHub issue form link; keys other than `template` and `title` are field ids of the form (RF-17, R11). */
export function issueUrl(repo: string, template: string, title: string, fields: Readonly<Record<string, string | undefined>>): string {
  const q = new URLSearchParams({ template, title });
  for (const [id, value] of Object.entries(fields)) if (value) q.set(id, value);
  return `https://github.com/${repo}/issues/new?${q.toString()}`;
}

/** R11 «Sugerir una fiesta»: the suggestion form, with the country prefilled when one is in view. */
export function suggestAction(ctx: Ctx, country?: string): EmptyAction {
  return { label: ctx.t("suggest.link"), href: issueUrl(ctx.repo, "sugerir-fiesta.yml", ctx.t("suggest.issueTitle"), { pais: country }), newTab: ctx.t("link.newTab") };
}

/** RF-13: data older than 30 days (or never verified) warns wherever its dates are shown. */
export function staleNotice(info: IndexCountry | undefined, ctx: Ctx): HTMLElement | null {
  if (!info || !isStale(info.last_verified, ctx.today)) return null;
  return notice(
    "warn",
    "alert",
    h(
      "p",
      null,
      info.last_verified
        ? ctx.t("fresh.stale", { country: countryName(info.code, ctx.lang), date: shortDate(info.last_verified, ctx.lang), days: relativeDays(info.last_verified, ctx.today, ctx.lang) })
        : ctx.t("fresh.never", { country: countryName(info.code, ctx.lang) }),
    ),
  );
}

export function errorState(error: unknown, ctx: Ctx): HTMLElement {
  const offline = error instanceof DataError ? error.kind === "offline" : true;
  return emptyState(ctx.t(offline ? "error.offlineTitle" : "error.dataTitle"), ctx.t(offline ? "error.offlineBody" : "error.dataBody"), [
    {
      label: ctx.t("error.retry"),
      primary: true,
      onClick: () => {
        clearFailed();
        ctx.refresh();
      },
    },
  ]);
}

/**
 * Renders `ready(value)` at once when the data is already loaded; otherwise a static skeleton
 * of the same footprint first, swapped in place when the data lands (no blank screen, no flash).
 */
export function asyncView<T>(res: Resource<T>, kind: "home" | "list" | "detail", ctx: Ctx, ready: (value: T) => Child): HTMLElement {
  const root = h("div", { class: "view" });
  if (res.value !== undefined) {
    root.append(h("div", { class: "view__content" }, ready(res.value)));
    return root;
  }
  if (res.error !== undefined) {
    root.append(errorState(res.error, ctx));
    return root;
  }
  root.setAttribute("aria-busy", "true");
  root.append(skeleton(kind));
  res.promise.then(
    (value) => {
      root.replaceChildren(h("div", { class: "view__content" }, ready(value)));
      root.removeAttribute("aria-busy");
      ctx.settled();
    },
    (error: unknown) => {
      root.replaceChildren(errorState(error, ctx));
      root.removeAttribute("aria-busy");
      ctx.settled();
    },
  );
  return root;
}
