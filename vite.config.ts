import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// No data: images: icons are inline SVG elements and the CSS embeds no data URLs (SEC-16).
// frame-ancestors cannot be set from a meta tag and GitHub Pages sends no custom headers.
export const CSP =
  "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; " +
  "font-src 'self'; base-uri 'self'; form-action 'none'";

/** Fonts the first screen paints with: preloaded so the swap lands before data renders (LCP, CLS). */
const PRELOAD_FONTS = [/anybody-latin-standard-normal.*\.woff2$/, /atkinson-hyperlegible-next-latin-wght-normal.*\.woff2$/];

/**
 * The first screen (the world view) reads the index and data/world.json (build-data
 * `worldBundle`: the tier-1 festivals in one file), so the build preloads exactly those two next to
 * the JS instead of after it: a network round trip off the LCP. It used to preload the first four
 * countries alphabetically, which with all of Latin America live were files the first screen
 * never read, fighting the ones it did for bandwidth.
 */
function dataPreloads(): string[] {
  return ["data/index.json", "data/world.json"].filter((path) => existsSync(`public/${path}`)); // a bare `vite build` has no data yet
}

/** Build only: the dev server needs inline scripts for HMR, so the CSP meta would break it. */
function productionHead(): Plugin {
  return {
    name: "traveler-production-head",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const base = ctx.server ? "/" : (process.env.BASE_PATH ?? "/");
        const fonts = Object.keys(ctx.bundle ?? {}).filter((file) => PRELOAD_FONTS.some((re) => re.test(file)));
        return [
          { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
          ...fonts.map((file) => ({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: `${base}${file}`, crossorigin: "" },
            injectTo: "head" as const,
          })),
          ...dataPreloads().map((path) => ({
            tag: "link",
            attrs: { rel: "preload", as: "fetch", type: "application/json", href: `${base}${path}`, crossorigin: "" },
            injectTo: "head" as const,
          })),
        ];
      },
    },
  };
}

type Messages = Record<string, string>;
const LOCALES = ["es", "en", "pt"] as const;

const escapeHtml = (v: string): string => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page the service worker answers with when it has no cached shell (first visit cut short).
 * Static and script-free, so its text comes from locales/*.json at build time, in every language.
 */
export function offlinePage(messages: Readonly<Record<(typeof LOCALES)[number], Messages>>, base: string): string {
  const blocks = LOCALES.map((lang) => {
    const m = messages[lang];
    const t = (key: string): string => escapeHtml(m[key] ?? messages.es[key] ?? key);
    return `<section lang="${lang}"><h1>${t("offline.pageTitle")}</h1><p>${t("offline.pageBody")}</p><p><a href="${escapeHtml(base)}">${t("offline.pageRetry")}</a></p></section>`;
  }).join("\n");
  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">`,
    `<title>${escapeHtml(messages.es["offline.pageTitle"] ?? "Traveler")} | Traveler</title>`,
    "</head>",
    "<body>",
    blocks,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function offlineFallback(): Plugin {
  return {
    name: "traveler-offline-page",
    apply: "build",
    generateBundle() {
      const messages = Object.fromEntries(LOCALES.map((lang) => [lang, JSON.parse(readFileSync(`locales/${lang}.json`, "utf8")) as Messages])) as Record<(typeof LOCALES)[number], Messages>;
      this.emitFile({ type: "asset", fileName: "offline.html", source: offlinePage(messages, process.env.BASE_PATH ?? "/") });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  build: { target: "es2022", assetsInlineLimit: 0 },
  plugins: [productionHead(), offlineFallback()],
});
