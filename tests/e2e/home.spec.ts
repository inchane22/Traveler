// Inicio: RF-01 «Lo próximo», RF-05 timeline with an equivalent list, RF-13 freshness and stale notice.
import { expect, test } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test.describe("Inicio", () => {
  test("RF-01: Cartagena is next in Colombia and its countdown is visible without scrolling", async ({ page }) => {
    await open(page, "#/pais/co");
    await expect(page.locator(".wordmark")).toHaveCount(1); // the static first-paint wordmark was replaced, not duplicated
    const hero = page.getByTestId("next-festival");
    await expect(hero.getByRole("heading", { level: 2 })).toHaveText("Fiestas de la Independencia de Cartagena");
    await expect(hero.locator("[data-countdown]")).toContainText("15");
    await expect(hero.getByRole("heading", { level: 2 })).toBeInViewport({ ratio: 1 });
    await expect(hero.locator("[data-countdown]")).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".next-list > li")).toHaveCount(2);
  });

  test("RF-01: the hero shows dates, status and confidence as text", async ({ page }) => {
    await open(page, "#/pais/co");
    const hero = page.getByTestId("next-festival");
    await expect(hero).toContainText("10–16 nov 2026");
    // One trust line: status shape and words, then where the date comes from (RF-07, RF-08).
    await expect(hero.locator(".trust")).toHaveText("Por confirmar, según años anteriores");
    await expect(hero.locator(".trust .status-shape")).toHaveCount(1);
  });

  test("an unconfirmed date counts down «en unos N días», never an exact promise", async ({ page }) => {
    await open(page, "#/pais/co");
    const hero = page.getByTestId("next-festival").locator("[data-countdown]");
    await expect(hero).toContainText("Empieza en unos");
    await expect(hero.locator(".sr-only")).toHaveText("En unos 15 días");
    // A confirmed festival keeps the exact count.
    await expect(page.locator(".next-row").filter({ hasText: "Feria de Cali" }).locator(".next-row__count")).toHaveText(/^En \d+ días$/);
  });

  test("the world and region views say which countries are live and that any other can be built", async ({ page }) => {
    await open(page, "#/");
    // Lists every published country, so it grows with each country the pipeline builds.
    await expect(page.getByTestId("pilot-note")).toContainText(/Ya publicados: Brasil, Colombia y Perú\. Cualquier otro país se puede construir/);
    await open(page, "#/region/sudamerica");
    await expect(page.getByTestId("pilot-note")).toBeVisible();
    await open(page, "#/pais/co");
    await expect(page.getByTestId("pilot-note")).toHaveCount(0);
    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    await expect(page.getByRole("dialog").getByTestId("scope-more")).toContainText("Cualquier otro país se puede construir");
  });

  test("«Cómo leer las marcas» opens the key in a sheet from the timeline", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.getByRole("button", { name: "Cómo leer las marcas" }).click();
    const sheet = page.getByRole("dialog", { name: "Cómo leer las marcas" });
    await expect(sheet.getByRole("list", { name: "Estados de una fecha" }).getByRole("listitem")).toHaveCount(5);
    await expect(sheet.getByRole("list", { name: "De dónde sale cada dato" })).toContainText("Años anteriores");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Cómo leer las marcas" })).toBeFocused();
  });

  test("RF-05: the 12-month timeline is an ordered list of links with dates and status in their names", async ({ page }) => {
    await open(page, "#/pais/co");
    const rows = page.locator(".tl-rows > li");
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    const first = rows.first().getByRole("link");
    await expect(first).toHaveAccessibleName(/Cartagena.*Fiesta nacional.*10–16 nov 2026.*Por confirmar/);
    await expect(page.locator(".tl-axis")).toHaveAttribute("aria-hidden", "true");
  });

  test("RF-05: the Nivel 2 switch lives in the URL", async ({ page }) => {
    await open(page, "#/pais/co");
    const sw = page.getByRole("switch", { name: "Incluir medianas (Nivel 2)" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(page).toHaveURL(/#\/pais\/co\?nivel=2$/);
    await expect(page.getByRole("switch", { name: "Incluir medianas (Nivel 2)" })).toHaveAttribute("aria-checked", "true");
  });

  // ux-F10: «Lo no confirmado lleva trama diagonal», on the hero's big band too (Cartagena is tentative).
  test("the hero band of an unconfirmed festival is hatched, never the solid «confirmada» band", async ({ page }) => {
    await open(page, "#/pais/co");
    const band = page.getByTestId("next-festival").locator(".poster__band");
    await expect(band).toHaveClass(/band--hatched/);
    expect(await band.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
  });

  test("RF-13: shows when the data was verified, and a stale notice after 30 days", async ({ page }) => {
    await open(page, "#/pais/co");
    await expect(page.locator(".freshness").first()).toContainText("Verificado hoy");
    await expect(page.locator(".notice--warn")).toHaveCount(0);

    await open(page, "#/pais/co", "2026-12-15");
    await expect(page.locator(".notice--warn")).toContainText("se verificaron por última vez el 26 oct 2026");
  });

  // R2: under 60% of dates with an A source the country is flagged. The committed share moves with
  // the data, so one run reads it as published and one serves the same index with the share lowered.
  test("RF-13: partial source coverage is flagged under 60% and only then", async ({ page }) => {
    await open(page, "#/pais/co");
    const index = (await (await page.request.get("/data/index.json")).json()) as { countries: { code: string; share_a: number }[] };
    const share = index.countries.find((c) => c.code === "CO")?.share_a;
    expect(typeof share).toBe("number");
    await expect(page.locator(".freshness--partial")).toHaveCount((share ?? 0) < 0.6 ? 1 : 0);

    await page.route("**/data/index.json", async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as typeof index;
      const countries = json.countries.map((c) => (c.code === "CO" ? { ...c, share_a: 0.5 } : c));
      await route.fulfill({ response, json: { ...json, countries } });
    });
    await page.reload();
    await settled(page);
    await expect(page.locator(".freshness--partial")).toContainText("Cobertura parcial");
    await expect(page.locator(".freshness--partial")).toContainText("50");
    // One trust line, not two: verified, partial coverage and the way to how we verify.
    await expect(page.locator(".freshness")).toHaveCount(1);
    await expect(page.locator(".freshness")).toContainText("Verificado hoy");
    await expect(page.locator(".freshness").getByRole("link", { name: "Cómo verificamos" })).toBeVisible();
  });

  test("offers webcal, Google and Outlook subscriptions for the country", async ({ page }) => {
    await open(page, "#/pais/co");
    const block = page.locator(".subscribe");
    await expect(block.getByRole("link", { name: "Suscribirse en Apple Calendar u Outlook (app)" })).toHaveAttribute("href", /^webcal:\/\/.+\/calendars\/co\.ics$/);
    await expect(block.getByRole("link", { name: /^Suscribirse en Google Calendar/ })).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);
    await expect(block.getByRole("link", { name: /^Suscribirse en Outlook\.com/ })).toHaveAttribute("href", /^https:\/\/outlook\.live\.com\/calendar\/0\/addfromweb\?url=/);
  });

  test("no animation runs on load", async ({ page }) => {
    await open(page, "#/pais/co");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test("an offline device sees a notice", async ({ page, context }) => {
    await open(page, "#/pais/co");
    await context.setOffline(true);
    await expect(page.locator(".notice--offline")).toBeVisible();
    await context.setOffline(false);
    await expect(page.locator(".notice--offline")).toHaveCount(0);
  });
});
