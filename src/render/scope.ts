// Scope picker (RF-02): world, a region, or a country found by a tolerant search; the three most
// recent countries come first. Festivals of published countries are searchable by name or city.
import type { Scope } from "../festivals.ts";
import { h } from "../h.ts";
import { countryName } from "../ics.ts";
import { REGIONS } from "../router.ts";
import { countryItems, search, searchCountries, type Searchable } from "../search.ts";
import type { FestivalEntry } from "../festivals.ts";
import { festivalName, placeLine } from "./components.ts";
import type { Ctx } from "./context.ts";
import { icon } from "./icons.ts";
import { entriesFor, loadCountry, loadIndex, type PublicIndex } from "./model.ts";
import { closeSheet, openSheet } from "./sheet.ts";

const MAX_RESULTS = 8;

interface FestivalItem extends Searchable {
  entry: FestivalEntry;
}

function optionLink(href: string, label: string, detail: string | null, current: boolean, key: string, onPick?: () => void): HTMLElement {
  return h(
    "a",
    { href, class: "option", "aria-current": current ? "true" : null, "data-key": key, onclick: () => onPick?.() },
    h("span", { class: "option__label" }, label),
    detail ? h("span", { class: "option__detail" }, detail) : null,
    current ? icon("check") : icon("chevronRight"),
  );
}

export function openScopeSheet(current: Scope, ctx: Ctx): void {
  const items = countryItems(ctx.lang);
  let index: PublicIndex | null = null;
  let festivals: FestivalItem[] = [];

  const input = h("input", {
    type: "search",
    id: "country-search",
    class: "search__input",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "search",
    "aria-describedby": "country-search-hint",
    "aria-controls": "country-results",
  });
  const status = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  const results = h("div", { id: "country-results", class: "scope__results" });

  const countryDetail = (code: string): string => {
    const info = index?.countries.find((c) => c.code === code);
    return info ? ctx.t("scope.festivals", { count: info.festivals }) : ctx.t("scope.noData");
  };

  const pick = (code: string) => () => {
    ctx.store.pushRecent(code);
    closeSheet();
  };

  const draw = (): void => {
    const query = input.value;
    const publishedCodes = index?.countries.map((c) => c.code) ?? [];
    const recent = ctx.store.get("recent");
    const countries = searchCountries(items, query, { recent, published: publishedCodes, limit: query.trim() ? MAX_RESULTS : 0 });
    const blocks: HTMLElement[] = [];

    if (!query.trim()) {
      const recentItems = recent.map((code) => items.find((i) => i.code === code)).filter((i) => !!i);
      if (recentItems.length) {
        blocks.push(
          h("h3", { class: "scope__group" }, ctx.t("scope.recent")),
          h("ul", { class: "options" }, recentItems.map((c) => h("li", null, optionLink(ctx.href({ name: "country", code: c.code, query: { tier2: false } }), c.name, countryDetail(c.code), current.kind === "country" && current.code === c.code, `recent-${c.code}`, pick(c.code))))),
        );
      }
      const pub = publishedCodes.filter((code) => !recent.includes(code));
      if (pub.length) {
        blocks.push(
          h("h3", { class: "scope__group" }, ctx.t("scope.published")),
          h("ul", { class: "options" }, pub.map((code) => h("li", null, optionLink(ctx.href({ name: "country", code, query: { tier2: false } }), countryName(code, ctx.lang), countryDetail(code), current.kind === "country" && current.code === code, `pub-${code}`, pick(code))))),
        );
      }
      status.textContent = "";
    } else {
      const fest = search(festivals, query, 5).map((hit) => hit.item.entry);
      if (countries.length) {
        blocks.push(
          h("h3", { class: "scope__group" }, ctx.t("scope.countries")),
          h(
            "ul",
            { class: "options", "data-testid": "country-results" },
            countries.map((c) => h("li", null, optionLink(ctx.href({ name: "country", code: c.code, query: { tier2: false } }), c.name, countryDetail(c.code), current.kind === "country" && current.code === c.code, `c-${c.code}`, pick(c.code)))),
          ),
        );
      }
      if (fest.length) {
        blocks.push(
          h("h3", { class: "scope__group" }, ctx.t("scope.festivalsGroup")),
          h("ul", { class: "options" }, fest.map((e) => h("li", null, optionLink(ctx.href({ name: "festival", slug: e.festival.slug }), festivalName(e.festival, ctx.lang), placeLine(e, ctx.lang), false, `f-${e.festival.slug}`, () => closeSheet())))),
        );
      }
      if (!countries.length && !fest.length) blocks.push(h("p", { class: "scope__none" }, ctx.t("scope.noResults", { query: query.trim() })));
      status.textContent = ctx.t("scope.resultsCount", { count: countries.length + fest.length });
    }
    results.replaceChildren(...blocks);
  };

  input.addEventListener("input", draw);

  const regionsWithData = (): string[] => [...new Set(index?.countries.map((c) => c.region) ?? [])].filter((r) => (REGIONS as readonly string[]).includes(r));
  const regionList = h("ul", { class: "options options--inline" });
  const drawRegions = (): void => {
    regionList.replaceChildren(
      ...regionsWithData().map((r) =>
        h("li", null, optionLink(`#/region/${r}`, ctx.t(`region.${r}`), null, current.kind === "region" && current.region === r, `region-${r}`, () => closeSheet())),
      ),
    );
  };

  openSheet({
    id: "scope-sheet",
    title: ctx.t("scope.title"),
    closeLabel: ctx.t("sheet.close"),
    initialFocus: "#country-search",
    body: () => [
      h(
        "div",
        { class: "search" },
        h("label", { for: "country-search", class: "search__label" }, ctx.t("scope.searchLabel")),
        h("div", { class: "search__field" }, icon("search"), input),
        h("p", { id: "country-search-hint", class: "search__hint" }, ctx.t("scope.searchHint")),
      ),
      status,
      results,
      h("h3", { class: "scope__group" }, ctx.t("scope.wider")),
      h(
        "ul",
        { class: "options" },
        h(
          "li",
          null,
          optionLink(ctx.href({ name: "home", query: { tier2: false } }), ctx.t("scope.worldOption"), ctx.t("scope.worldDetail"), current.kind === "world", "world", () => {
            ctx.store.set("scope", { kind: "world" });
            closeSheet();
            // Already on #/ (showing a remembered country): the hash does not change, so redraw.
            if (ctx.route.name === "home") ctx.refresh();
          }),
        ),
      ),
      regionList,
    ],
  });

  draw();
  loadIndex()
    .then(async (idx) => {
      index = idx;
      draw();
      drawRegions();
      const countries = await Promise.all(idx.countries.map((c) => loadCountry(c.code)));
      festivals = countries.flatMap((c) => entriesFor(c, ctx.today)).map((entry) => ({
        id: entry.festival.slug,
        entry,
        names: [entry.festival.names[ctx.lang], entry.festival.names.local, entry.festival.names.es, entry.festival.names.en, entry.festival.names.pt, entry.festival.city],
      }));
      if (input.value.trim()) draw();
    })
    .catch(() => {
      /* The picker still works from the platform's country names; counts appear once data loads. */
    });
}
