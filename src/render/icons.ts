// Stroke icons drawn on a 24px grid. Always decorative (aria-hidden): every icon sits next to text.
import { s } from "../h.ts";

const PATHS: Record<string, readonly string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5.5 9v11.5h13V9", "M10 20.5v-6h4v6"],
  explore: ["M4 6h16", "M4 12h10", "M4 18h6", "M17 15l3 3-3 3"],
  saved: ["M6.5 3.5h11v17l-5.5-4-5.5 4z"],
  settings: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 4.5v5", "M9 14.5v5"],
  chevronDown: ["M6 9.5l6 6 6-6"],
  chevronRight: ["M9.5 6l6 6-6 6"],
  back: ["M14.5 6l-6 6 6 6"],
  calendar: ["M4 6.5h16v14H4z", "M4 10.5h16", "M8.5 3.5v5", "M15.5 3.5v5"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  pin: ["M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z", "M12 12.3a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
  download: ["M12 4v11", "M7 10.5l5 5 5-5", "M5 20h14"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5 20 20"],
  alert: ["M12 3.5 21.5 20h-19z", "M12 10v4.5", "M12 17.2v.3"],
  offline: ["M3 3l18 18", "M8.5 16.5a5 5 0 0 1 7 0", "M5 12.9a10 10 0 0 1 4.2-2.4", "M14.8 10.5A10 10 0 0 1 19 12.9", "M12 20h.01"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3c2.6 2.5 3.8 5.5 3.8 9s-1.2 6.5-3.8 9c-2.6-2.5-3.8-5.5-3.8-9S9.4 5.5 12 3z"],
  flag: ["M5 21V4", "M5 4.5h12l-2.5 4 2.5 4H5"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  rss: ["M5 5a14 14 0 0 1 14 14", "M5 11a8 8 0 0 1 8 8", "M5.5 18.5h.01"],
};

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, filled = false): SVGElement {
  const paths = PATHS[name] ?? [];
  return s(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: "24",
      height: "24",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
      class: `icon icon--${name}`,
    },
    paths.map((d) => s("path", { d })),
  );
}

/** The wordmark's mark: a pennant (banderín), the street-party garland in one shape. */
export function brandMark(): SVGElement {
  return s(
    "svg",
    { viewBox: "0 0 24 24", width: "24", height: "24", "aria-hidden": "true", focusable: "false", class: "wordmark__mark" },
    s("path", { d: "M2 4h20L12 21z", fill: "currentColor" }),
    s("path", { d: "M7.5 8.5h9L12 16z", class: "wordmark__hole" }),
  );
}
