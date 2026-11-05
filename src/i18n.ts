// Every visible string lives in locales/*.json (flat dotted keys). Pure module: no DOM access,
// so Node tests and scripts can use it with dictionaries passed in.
import type { Lang } from "./schema.ts";

export type Messages = Readonly<Record<string, string>>;
export type Params = Record<string, string | number>;
export type Translate = (key: string, params?: Params) => string;

export const LANGS: readonly Lang[] = ["es", "en", "pt"];
export const DEFAULT_LANG: Lang = "es";

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** First supported base language among the browser's preferences («es-PE» → «es»). */
export function detectLang(preferences: readonly string[] | undefined): Lang {
  for (const tag of preferences ?? []) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}

function fill(template: string, params: Params | undefined, numberFormat: Intl.NumberFormat): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in params)) return match;
    const value = params[name];
    return typeof value === "number" ? numberFormat.format(value) : String(value);
  });
}

export interface I18n {
  readonly lang: Lang;
  t: Translate;
  has: (key: string) => boolean;
}

/**
 * Builds `t` for one language. With a numeric `count` param the key is pluralized through
 * Intl.PluralRules: `key.one`, `key.other` (and `key.zero` when a locale wants an explicit zero).
 * Missing keys fall back to Spanish, then to the key itself so a gap is visible, never blank.
 */
export function createI18n(all: Readonly<Record<Lang, Messages>>, lang: Lang): I18n {
  const messages = all[lang];
  const fallback = all[DEFAULT_LANG];
  const plural = new Intl.PluralRules(lang);
  const numberFormat = new Intl.NumberFormat(lang);
  const lookup = (key: string): string | undefined => messages[key] ?? fallback[key];

  const t: Translate = (key, params) => {
    const count = params?.count;
    if (typeof count === "number") {
      const exact = count === 0 ? lookup(`${key}.zero`) : undefined;
      const form = exact ?? lookup(`${key}.${plural.select(count)}`) ?? lookup(`${key}.other`);
      if (form !== undefined) return fill(form, params, numberFormat);
    }
    const template = lookup(key);
    return template === undefined ? key : fill(template, params, numberFormat);
  };

  return { lang, t, has: (key) => lookup(key) !== undefined };
}
