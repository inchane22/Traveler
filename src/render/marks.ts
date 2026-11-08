// «Cómo leer las marcas»: the status and confidence keys, on Sobre los datos and in a sheet one
// tap away from every list that shows the marks.
import { h } from "../h.ts";
import { confidenceShape, statusShape } from "./components.ts";
import type { Ctx } from "./context.ts";
import { openSheet } from "./sheet.ts";

export function marksKey(ctx: Ctx): HTMLElement {
  return h(
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
  );
}

export function openMarksSheet(ctx: Ctx): void {
  openSheet({
    id: "marks-sheet",
    title: ctx.t("about.marksTitle"),
    closeLabel: ctx.t("sheet.close"),
    readOnly: true,
    body: () => [h("p", { class: "sheet__note" }, ctx.t("marks.lede")), marksKey(ctx)],
  });
}

/** Small text button that opens the key; `key` keeps focus on it across re-renders. */
export function marksButton(ctx: Ctx, key: string): HTMLElement {
  return h("button", { type: "button", class: "btn btn--ghost btn--small marks-help", "aria-haspopup": "dialog", "data-key": key, onclick: () => openMarksSheet(ctx) }, ctx.t("about.marksTitle"));
}
