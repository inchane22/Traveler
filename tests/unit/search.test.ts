// RF-02: country search tolerant to accents, case and language.
import { describe, expect, test } from "vitest";
import { countryItems, matchScore, normalize, search, searchCountries, type CountryItem } from "../../src/search.ts";

const es = countryItems("es");
const codes = (items: readonly CountryItem[]): string[] => items.map((c) => c.code);

describe("normalize", () => {
  test("drops diacritics, case and punctuation", () => {
    expect(normalize("  Perú ")).toBe("peru");
    expect(normalize("São Tomé y Príncipe")).toBe("sao tome y principe");
    expect(normalize("Côte d’Ivoire")).toBe("cote d ivoire");
  });

  test("returns an empty string for punctuation only", () => {
    expect(normalize(" ,.;-_ ")).toBe("");
  });
});

describe("matchScore", () => {
  test("ranks exact over prefix over word prefix over substring", () => {
    expect(matchScore("peru", ["Perú"])).toBe(4);
    expect(matchScore("per", ["Perú"])).toBe(3);
    expect(matchScore("unid", ["Estados Unidos"])).toBe(2);
    expect(matchScore("nido", ["Estados Unidos"])).toBe(1);
  });

  test("ignores substrings shorter than three characters and empty queries", () => {
    expect(matchScore("ru", ["Perú"])).toBe(0);
    expect(matchScore("", ["Perú"])).toBe(0);
    expect(matchScore("peru", ["", "  "])).toBe(0);
  });
});

describe("search", () => {
  test("keeps the caller's order on ties and respects the limit", () => {
    const items = [
      { id: "a", names: ["Santa Marta"] },
      { id: "b", names: ["Santa Cruz"] },
      { id: "c", names: ["Santiago"] },
    ];
    expect(search(items, "sant").map((h) => h.item.id)).toEqual(["a", "b", "c"]);
    expect(search(items, "santa", 1).map((h) => h.item.id)).toEqual(["a"]);
    expect(search(items, "zzz")).toEqual([]);
  });
});

describe("searchCountries (Intl.DisplayNames in es, en and pt)", () => {
  test.each(["peru", "Perú", "Peru", "PERU", " perú "])("«%s» finds Perú first", (query) => {
    expect(searchCountries(es, query)[0]?.code).toBe("PE");
  });

  test("an English name finds the country in the Spanish UI: brazil → Brasil", () => {
    const [first] = searchCountries(es, "brazil");
    expect(first?.code).toBe("BR");
    expect(first?.name).toBe("Brasil");
  });

  test("a Portuguese name and the ISO code also match", () => {
    expect(searchCountries(es, "Colômbia")[0]?.code).toBe("CO");
    expect(searchCountries(es, "co")[0]?.code).toBe("CO");
  });

  test("an empty query lists recent countries first, most recent first", () => {
    const list = searchCountries(es, "", { recent: ["MX", "PE"], limit: 3 });
    expect(codes(list).slice(0, 2)).toEqual(["MX", "PE"]);
    expect(list).toHaveLength(3);
  });

  test("published countries win ties on the same score", () => {
    const list = searchCountries(es, "bo", { published: ["BO"] });
    expect(list[0]?.code).toBe("BO");
  });

  test("returns nothing for a query that matches no country", () => {
    expect(searchCountries(es, "qqqq")).toEqual([]);
  });
});

describe("countryItems", () => {
  test("drops codes without a display name and sorts by the UI-language name", () => {
    const names: Record<string, string> = { PE: "Perú", AR: "Argentina", ZZ: "ZZ" };
    const items = countryItems("es", ["PE", "AR", "ZZ", "QQ"], (_lang, code) => names[code]);
    expect(codes(items)).toEqual(["AR", "PE"]);
    expect(items[1]?.names).toContain("PE");
  });

  test("names each country in the requested language", () => {
    const en = countryItems("en", ["DE", "BR"]);
    expect(en.map((c) => c.name)).toEqual(["Brazil", "Germany"]);
    expect(en[1]?.names).toEqual(expect.arrayContaining(["Germany", "Alemania", "Alemanha", "DE"]));
  });
});
