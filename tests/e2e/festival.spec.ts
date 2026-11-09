// Ficha: RF-06 content, RF-07 status, RF-08 confidence labels, sources one tap away, RF-17 reports,
// RF-12 deep links to every screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { downloadText, open, unfold } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");

test.use({ serviceWorkers: "block" });

test.describe("Ficha", () => {
  test("RF-06/07/08: Barranquilla shows its dates, status and confidence as text", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Carnaval de Barranquilla");
    const when = page.locator(".when");
    await expect(when).toContainText("6–9 feb 2027");
    await expect(when.locator(".status")).toHaveText("Confirmada");
    await expect(when.locator(".conf")).toHaveText("Fuente: Oficial");
    await expect(page.locator(".fhead__place")).toContainText("Barranquilla, Colombia");
  });

  test("RF-06: every date opens its source in one tap", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const dateLink = page.locator(".when__range");
    await expect(dateLink).toHaveAttribute("href", /^https:\/\/(www\.)?carnavaldebarranquilla\.org/);
    await expect(dateLink).toHaveAttribute("target", "_blank");
    await expect(dateLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(dateLink).toHaveAccessibleName(/6–9 feb 2027.*fuente: Carnaval de Barranquilla/i);
    // A key-event day opens its source in one tap through its confidence label («● Oficial ↗»);
    // a day no source gives (ux-F05) says why instead. The day itself is plain text.
    for (const ev of await page.locator(".event").all()) {
      const link = ev.locator("a.event__source");
      if ((await link.count()) === 0) await expect(ev.locator(".event__rule")).not.toBeEmpty();
      else await expect(link).toHaveAttribute("href", /^https:\/\//);
    }
    await expect(page.locator("a.event__source")).toHaveCount(6);
    await expect(page.locator("a.event__date")).toHaveCount(0);
    await expect(page.locator("a.event__source").first()).toHaveAccessibleName(/^Oficial ?, fuente: Carnaval de Barranquilla.+\(se abre en otra pestaña\)$/);
  });

  test("RF-06: sources list the publisher and the verification date", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const sources = page.locator(".sources .source");
    await expect(sources.first().locator(".source__link")).toContainText("Carnaval de Barranquilla");
    await expect(sources.first()).toContainText("Consultada el");
    await expect(page.locator("section[aria-labelledby='sources-title'] .freshness")).toContainText("Verificado");
  });

  test("RF-06: the score is broken down per criterion, with unmeasured ones shown as a range", async ({ page }) => {
    await open(page, "#/fiesta/independencia-cartagena");
    await expect(page.locator(".score-total__value")).toHaveText(/^\d+ a \d+/);
    await expect(page.locator(".crit--unmeasured").first()).toContainText("Por medir");
    await expect(page.locator(".crit")).toHaveCount(5);
  });

  // Cartagena 2026: a tentative edition with sources but no dates of its own (the days come from
  // the rule). Negros y Blancos: no edition at all. Neither date may pose as sourced.
  for (const slug of ["independencia-cartagena", "negros-y-blancos"]) {
    test(`RF-07/08: a date from the rule is tentative, by pattern, and says where it comes from (${slug})`, async ({ page }) => {
      await open(page, `#/fiesta/${slug}`);
      const when = page.locator(".when");
      await expect(when.locator(".status")).toHaveText("Por confirmar");
      await expect(when.locator(".conf")).toHaveText("Fuente: Años anteriores");
      await expect(when.locator(".when__rule")).toContainText("regla");
      await expect(when.locator(".when__band")).toHaveClass(/band--hatched/);
      await expect(when.locator(".when__range")).not.toHaveAttribute("href", /.*/);
    });
  }

  test("RF-17: report links prefill the GitHub issue form by its field ids", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const hrefOf = async (name: RegExp): Promise<URL> => new URL((await page.getByRole("link", { name }).getAttribute("href")) ?? "");
    const error = await hrefOf(/Reportar un error/);
    expect(error.origin + error.pathname).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/);
    expect(error.searchParams.get("template")).toBe("reportar-error.yml");
    expect(error.searchParams.get("fiesta")).toBe("carnaval-barranquilla");
    expect(error.searchParams.get("campo")).toBe("editions.2027.start/end");
    expect(error.searchParams.get("fuente")).toMatch(/^https:\/\//);
    const content = await hrefOf(/Reportar contenido/);
    expect(content.searchParams.get("template")).toBe("reportar-contenido.yml");
    expect(content.searchParams.get("fiesta")).toBe("carnaval-barranquilla");
    // Every prefilled key is a field id the issue form declares (the form ignores anything else).
    for (const url of [error, content]) {
      const yaml = readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE", url.searchParams.get("template") ?? ""), "utf8");
      const ids = new Set([...yaml.matchAll(/^\s+id:\s*([\w-]+)\s*$/gm)].map((m) => m[1]));
      const keys = [...url.searchParams.keys()].filter((k) => k !== "template" && k !== "title");
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => !ids.has(k))).toEqual([]);
    }
  });

  test("Guardar and «Agregar al calendario» stay in reach at the bottom", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await page.mouse.wheel(0, 1200);
    await expect(page.getByRole("button", { name: "Agregar al calendario" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeInViewport({ ratio: 1 });
  });

  // The ficha has «Volver»: on phones its action bar takes the bottom nav's place in the thumb zone.
  test("phones: the ficha drops the bottom nav, Volver leads the masthead, the bars take ≤ 15 % of the screen", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "the bottom nav is the phone layout");
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".bottomnav")).toBeHidden();
    const bar = await page.locator(".actionbar").boundingBox();
    expect(Math.round((bar?.y ?? 0) + (bar?.height ?? 0))).toBe(844);
    const share = await page.evaluate(() => (document.querySelector(".masthead")!.getBoundingClientRect().height + document.querySelector(".actionbar")!.getBoundingClientRect().height) / innerHeight);
    expect(share).toBeLessThanOrEqual(0.15);
    const order = await page.locator(".masthead__inner > *").evaluateAll((els) => els.map((el) => (el.getAttribute("class") ?? "").split(" ").find((c) => c === "masthead__back" || c === "wordmark" || c === "topnav")));
    expect(order.slice(0, 2)).toEqual(["masthead__back", "wordmark"]);
    await open(page, "#/pais/co");
    await expect(page.locator(".bottomnav")).toBeVisible();
  });

  test("the travel advisory of the origin country links from the ficha", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("traveler.origin", JSON.stringify("GB"));
      } catch {
        /* storage blocked: the test then fails on the missing section */
      }
    });
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".advisory a")).toHaveAttribute("href", "https://www.gov.uk/foreign-travel-advice/colombia");
  });

  // ux-F14: a chosen origin without a verified page says so instead of showing nothing.
  test("R6: an origin without a verified advisory link says so, and Ajustes names the covered ones", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        // Japan has no entry in config/advisories.json (neither a Colombia page nor a general one).
        localStorage.setItem("traveler.origin", JSON.stringify("JP"));
      } catch {
        /* storage blocked: the test then fails on the missing section */
      }
    });
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".advisory")).toContainText("Aún no tenemos el enlace verificado de Japón");
    await expect(page.locator(".advisory a")).toHaveCount(0);
    await open(page, "#/ajustes");
    await expect(page.locator("#origin-hint")).toContainText("Reino Unido");
    await expect(page.locator("#origin-hint")).toContainText("Estados Unidos");
    await expect(page.locator("#origin-hint")).not.toContainText("Japón");
  });

  test("R6: a trip inside the home country shows no advisory section", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("traveler.origin", JSON.stringify("CO"));
      } catch {
        /* storage blocked: no origin, no section either */
      }
    });
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".advisory")).toHaveCount(0);
  });

  // ux-F07: the stale warning travels with the dates, to deep links and the explorer.
  test("RF-13: a ficha and Explorar warn when the country's data is stale", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".notice--warn")).toHaveCount(0);
    await open(page, "#/fiesta/carnaval-barranquilla", "2026-12-10");
    await expect(page.locator(".notice--warn")).toContainText("se verificaron por última vez el 26 oct 2026");
    await open(page, "#/explorar?pais=co&mes=2027-02", "2026-12-10");
    await expect(page.locator(".notice--warn")).toContainText("se verificaron por última vez el 26 oct 2026");
  });

  // ux-F05, DH-07: «Toda fecha abre su fuente», and only a source that backs that date.
  test("RF-08: a key-event date links only to a source that backs it", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const martes = page.locator(".event").filter({ hasText: "Martes de Carnaval" });
    await expect(martes.locator(".conf")).toHaveText("Años anteriores");
    await expect(martes.locator("a")).toHaveCount(0);
    await expect(page.locator(".event").filter({ hasText: "Batalla de Flores" }).locator("a.event__source")).toHaveAttribute("href", /^https:\/\//);

    // Feria de las Flores 2026: only the Silleteros date is quoted (El Espectador); the official
    // page gives the feria's range, not the parades, so the other press dates stay plain text.
    await open(page, "#/fiesta/feria-de-las-flores", "2026-07-01");
    await expect(page.locator(".event").filter({ hasText: "Desfile de Silleteros" }).locator("a.event__source")).toHaveAttribute("href", /elespectador\.com/);
    for (const name of ["Desfile de Chivas y Flores", "Avenida Primavera", "Desfile de Autos Clásicos y Antiguos"]) {
      await expect(page.locator(".event").filter({ hasText: name }).locator("a"), name).toHaveCount(0);
    }
  });

  // ux-F10: «Lo no confirmado lleva trama diagonal», on the big band too. One band per ficha: the
  // dates card's top edge, like the Inicio poster.
  test("the ficha's one band tops the dates card and is hatched when the date is not confirmed", async ({ page }) => {
    await open(page, "#/fiesta/independencia-cartagena");
    await expect(page.locator(".band, .poster__band").filter({ visible: true })).toHaveCount(1);
    const band = page.locator(".when > .when__band");
    await expect(band).toHaveClass(/band--hatched/);
    expect(await band.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".when > .when__band")).toHaveClass(/band--solid/);
    await expect(page.locator(".fhead .poster__band")).toHaveCount(0);
  });

  test("the month grid explains its marks", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const legend = page.locator(".mg-legend");
    await expect(legend).toContainText("Confirmada");
    await expect(legend).toContainText("Momento clave");
    await open(page, "#/fiesta/independencia-cartagena");
    await expect(page.locator(".mg-legend")).toContainText("Por confirmar");
  });

  test("an unknown festival shows a not-found state with actions", async ({ page }) => {
    await open(page, "#/fiesta/no-existe");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".empty__actions a").first()).toBeVisible();
  });

  test("«Volver» on a ficha opened from a shared link lands on Explorar", async ({ page }) => {
    await open(page, "#/fiesta/feria-de-cali");
    await page.locator(".masthead").getByRole("button", { name: "Volver" }).click();
    await expect(page).toHaveURL(/#\/explorar/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Explorar");
  });

  // code-F4: festival links are plain anchors; «Volver» must be a real Back, not a push to Explorar.
  test("«Volver» on a ficha opened from Inicio goes back to Inicio without a new history entry", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.getByTestId("next-festival").getByRole("link").click();
    await expect(page).toHaveURL(/#\/fiesta\//);
    const length = await page.evaluate(() => history.length);
    await page.locator(".masthead").getByRole("button", { name: "Volver" }).click();
    await expect(page).toHaveURL(/#\/pais\/co$/);
    expect(await page.evaluate(() => history.length)).toBe(length);
  });

  test("«Volver» on a ficha opened from Guardadas goes back to Guardadas", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("traveler.saved", JSON.stringify(["feria-de-cali"]));
      } catch {
        /* the list is then empty and the click below fails */
      }
    });
    await open(page, "#/guardadas");
    await page.locator("main").getByRole("link", { name: "Feria de Cali", exact: true }).click();
    await expect(page).toHaveURL(/#\/fiesta\/feria-de-cali$/);
    const length = await page.evaluate(() => history.length);
    await page.locator(".masthead").getByRole("button", { name: "Volver" }).click();
    await expect(page).toHaveURL(/#\/guardadas$/);
    expect(await page.evaluate(() => history.length)).toBe(length);
  });

  test("«Volver» after browsing returns to the exact list it came from", async ({ page }) => {
    await open(page, "#/explorar?pais=co&tipo=carnaval");
    await page.getByTestId("results").locator("[data-slug='carnaval-barranquilla'] a").first().click();
    await expect(page).toHaveURL(/#\/fiesta\/carnaval-barranquilla$/);
    await page.locator(".masthead").getByRole("button", { name: "Volver" }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co&tipo=carnaval$/);
  });
});

test.describe("RF-12: deep links open each screen directly", () => {
  const routes: [string, RegExp][] = [
    ["#/pais/co", /Colombia/],
    ["#/region/sudamerica", /Sudamérica/],
    ["#/explorar?pais=co&tipo=carnaval", /^Explorar$/],
    ["#/fiesta/feria-de-cali", /^Feria de Cali$/],
    ["#/guardadas", /^Guardadas$/],
    ["#/ajustes", /^Ajustes$/],
    ["#/datos", /^Sobre los datos$/],
  ];
  for (const [hash, title] of routes) {
    test(hash, async ({ page }) => {
      await open(page, hash);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    });
  }

  test("filters from a shared link are applied", async ({ page }) => {
    await open(page, "#/explorar?pais=co&tipo=carnaval");
    await expect(page.locator('[data-key="tipo-carnaval"]')).toHaveAttribute("aria-pressed", "true");
  });
});

// prd-F15: no published festival is cancelled or moon-dependent right now, so these tests serve a
// copy of the country file with one of each: RF-07 (struck through, with its source, CANCELLED in
// the .ics) and RF-19 (a sighting-dependent date is an estimate).
test.describe("RF-07 and RF-19 on served fixture data", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/data/countries/co.json", async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { festivals: { slug: string; editions?: Record<string, Record<string, unknown>> }[] };
      const festivals = json.festivals.map((f) => {
        const cali = f.editions?.["2026"];
        if (f.slug === "feria-de-cali" && cali) return { ...f, editions: { ...f.editions, "2026": { ...cali, status: "cancelada", sequence: Number(cali.sequence ?? 0) + 1 } } };
        if (f.slug === "san-pacho") {
          const table = { "2026": { start: "2026-12-10", end: "2026-12-12" }, "2027": { start: "2027-11-30", end: "2027-12-02" } };
          return { ...f, rule: { type: "lunisolar_table", calendar: "islamic", sighting_dependent: true, table, table_source: "https://www.timeanddate.com/holidays/colombia/" } };
        }
        return f;
      });
      await route.fulfill({ response, json: { ...json, festivals } });
    });
  });

  test("RF-07: a cancelled edition is struck through, links its source and exports CANCELLED", async ({ page }) => {
    await open(page, "#/fiesta/feria-de-cali");
    await expect(page.getByRole("heading", { level: 1 })).toHaveClass(/is-struck/);
    await expect(page.locator(".when .status")).toHaveText("Cancelada");
    // No countdown towards days it will not have (src/status.ts).
    await expect(page.locator(".when [data-countdown]")).toHaveText("No se realizará");
    await expect(page.locator(".notice--cancel a")).toHaveAttribute("href", /^https:\/\//);
    await page.getByRole("button", { name: "Agregar al calendario" }).click();
    const { text } = await downloadText(page, page.getByTestId("ics-download"));
    const ics = unfold(text);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toMatch(/SUMMARY:\[Cancelada\]/);
  });

  test("RF-19: a moon-dependent date says it is an estimate that may shift by a day", async ({ page }) => {
    await open(page, "#/fiesta/san-pacho");
    await expect(page.locator(".moon-note")).toHaveText(/^Estimada, puede variar un día/);
    await expect(page.locator(".when__band")).toHaveClass(/band--hatched/);
  });
});

// UI-2: a postponed edition with no new dates, its old window already past (Petronio 2026, the
// source points at November). It is not over and the August window is no longer probable.
test("a pending postponement reads as a new date to come, not as ended", async ({ page }) => {
  await open(page, "#/fiesta/petronio-alvarez");
  const when = page.locator(".when");
  await expect(when).toContainText("Nueva fecha por anunciar");
  await expect(when).toContainText("Fecha original: 1–31 ago 2026");
  await expect(when).not.toContainText("Ya terminó");
  await expect(when).not.toContainText("Ventana probable");
  await expect(when).not.toContainText("Calculada con la regla");
  await expect(when.locator(".mg-head")).toHaveCount(0);
});
