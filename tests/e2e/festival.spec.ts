// Ficha: RF-06 content, RF-07 status, RF-08 confidence labels, sources one tap away, RF-17 reports,
// RF-12 deep links to every screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

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
    for (const link of await page.locator(".event__date").all()) await expect(link).toHaveAttribute("href", /^https:\/\//);
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

  test("RF-07/08: a date from the rule is tentative, by pattern, and says where it comes from", async ({ page }) => {
    await open(page, "#/fiesta/independencia-cartagena");
    const when = page.locator(".when");
    await expect(when.locator(".status")).toHaveText("Tentativa");
    await expect(when.locator(".conf")).toHaveText("Fuente: Patrón");
    await expect(when.locator(".when__rule")).toContainText("regla");
    await expect(when.locator(".when__band")).toHaveClass(/band--hatched/);
  });

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
    await expect(page.getByRole("button", { name: /^Carnaval/ })).toHaveAttribute("aria-pressed", "true");
  });
});
