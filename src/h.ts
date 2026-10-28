// Tiny DOM builder. Text always goes in through text nodes (never innerHTML), so data from the
// country files can never become markup. Styles go through the CSSOM (CSP forbids style attributes).

export type Child = Node | string | number | null | undefined | false | readonly Child[];

type Handler = (event: Event) => void;

export interface Attrs {
  [name: string]: string | number | boolean | null | undefined | Handler | Record<string, string>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Only https links leave the site; anything else external is dropped to plain text. */
export function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "srcset"]);
const SAFE_SCHEMES = new Set(["https:", "http:", "mailto:", "webcal:", "blob:"]);

/**
 * Any URL-bearing attribute: relative paths and same-document hashes pass, and so do https, http,
 * mailto, webcal (calendar feeds) and blob (local .ics downloads). javascript:, data:, vbscript:
 * and every other scheme are refused, so a future caller cannot turn data into a script link.
 */
export function safeAttrUrl(value: string): boolean {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\u0000-\u0020]/g, ""));
  if (!scheme) return true; // relative or #hash: resolved against the site itself
  return SAFE_SCHEMES.has(`${(scheme[1] ?? "").toLowerCase()}:`);
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child as readonly Child[]) append(parent, c);
    return;
  }
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  parent.appendChild(child as Node);
}

function applyAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) (el as HTMLElement | SVGElement).style.setProperty(prop, v);
      continue;
    }
    if (name.startsWith("on") && typeof value === "function") {
      el.addEventListener(name.slice(2).toLowerCase(), value as Handler);
      continue;
    }
    if (typeof value === "function" || typeof value === "object") continue;
    if (name === "style") continue;
    if (/^on/i.test(name)) continue; // string handlers would be inline script (and CSP blocks them anyway)
    if (URL_ATTRS.has(name.toLowerCase()) && !safeAttrUrl(String(value))) continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
}

/** HTML element. `href` on an external link must be https; such links open safely in a new tab. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const a = attrs ? { ...attrs } : undefined;
  if (tag === "a" && a && typeof a.href === "string" && a.external === true) {
    const safe = safeExternalUrl(a.href);
    if (!safe) {
      const span = document.createElement("span");
      append(span, children);
      return span as unknown as HTMLElementTagNameMap[K];
    }
    a.href = safe;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
  }
  if (a) delete a.external;
  applyAttrs(el, a);
  append(el, children);
  return el;
}

/** SVG element (icons, status shapes, confidence marks). */
export function s(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  applyAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

/** Visually hidden text that screen readers still announce. */
export function srOnly(text: string): HTMLSpanElement {
  return h("span", { class: "sr-only" }, text);
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  const frag = document.createDocumentFragment();
  append(frag, children);
  parent.replaceChildren(frag);
}
