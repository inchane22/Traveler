// Bottom sheet on phones, centered panel on desktop. Native <dialog> + showModal gives the focus
// trap, Escape, the inert background and the top layer without extra code.
import { h, type Child } from "../h.ts";
import { icon } from "./icons.ts";

export interface SheetOptions {
  id: string;
  title: string;
  closeLabel: string;
  body: (close: () => void) => Child;
  onClose?: () => void;
  initialFocus?: string;
}

let open: HTMLDialogElement | null = null;

export function closeSheet(): void {
  open?.close();
}

export function openSheet(opts: SheetOptions): HTMLDialogElement {
  open?.close();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `${opts.id}-title`;
  const dialog = h("dialog", { class: "sheet", id: opts.id, "aria-labelledby": titleId });
  const close = (): void => dialog.close();
  dialog.append(
    h(
      "div",
      { class: "sheet__panel" },
      h(
        "div",
        { class: "sheet__head" },
        h("h2", { class: "sheet__title display", id: titleId }, opts.title),
        h("button", { type: "button", class: "icon-btn sheet__close", "aria-label": opts.closeLabel, onclick: close }, icon("close")),
      ),
      h("div", { class: "sheet__body" }, opts.body(close)),
    ),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (open === dialog) open = null;
    opts.onClose?.();
    if (opener?.isConnected) opener.focus();
  });
  document.body.append(dialog);
  open = dialog;
  dialog.showModal();
  const target = opts.initialFocus ? dialog.querySelector<HTMLElement>(opts.initialFocus) : null;
  target?.focus();
  return dialog;
}
