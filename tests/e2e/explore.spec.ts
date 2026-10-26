// Explorar: RF-03 chips with counts, URL state and Back; RF-04 «Mis fechas de viaje»; empty states.
import { expect, test } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

const count = (page: import("@playwright/test").Page) => page.getByTestId("result-count");

test.describe("Explorar", () => {
  test("RF-03: every chip shows its count", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    const chips = page.locator(".chip");
    expect(await chips.count()).toBeGreaterThan(15);
    for (const chip of await chips.all()) await expect(chip.locator(".chip__count")).toHaveText(/\d+/);
    await expect(page.getByRole("button", { name: "Colombia (10 fiestas)" })).toHaveAttribute("aria-pressed", "true");
  });

  test("RF-03: filters live in the URL and Back restores them", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await expect(count(page)).toHaveText(/\d+ fiestas/);
    const all = await count(page).textContent();

    await page.getByRole("button", { name: /^Carnaval \(\d+ fiestas?\)$/ }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co&tipo=carnaval$/);
    await expect(page.getByRole("button", { name: /^Carnaval/ })).toHaveAttribute("aria-pressed", "true");
    await expect(count(page)).not.toHaveText(all ?? "");
    const carnavalCount = await count(page).textContent();

    await page.getByRole("button", { name: /^febrero de 2027/ }).click();
    await expect(page).toHaveURL(/mes=2027-02/);
    await expect(page.getByTestId("results")).toContainText("Carnaval de Barranquilla");

    await page.goBack();
    await expect(page).toHaveURL(/#\/explorar\?pais=co&tipo=carnaval$/);
    await settled(page);
    await expect(page.getByRole("button", { name: /^febrero de 2027/ })).toHaveAttribute("aria-pressed", "false");
    await expect(count(page)).toHaveText(carnavalCount ?? "");

    await page.goBack();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
    await expect(count(page)).toHaveText(all ?? "");
  });

  test("RF-03: «Limpiar filtros» is always visible and clears everything in one tap", async ({ page }) => {
    await open(page, "#/explorar?pais=co&tipo=carnaval&nivel=2&desde=2027-01-01");
    const clear = page.getByRole("button", { name: "Limpiar filtros" });
    await page.mouse.wheel(0, 1500);
    await expect(clear).toBeInViewport();
    await clear.click();
    await expect(page).toHaveURL(/#\/explorar$/);
    await expect(page.getByRole("button", { name: "Limpiar filtros" })).toBeDisabled();
  });

  test("RF-03: the Nivel 2 switch shows its count and widens the list", async ({ page }) => {
    await open(page, "#/explorar");
    const before = Number((await count(page).textContent())?.match(/\d+/)?.[0]);
    const sw = page.getByRole("switch", { name: /Incluir Nivel 2/ });
    await expect(sw.locator(".chip__count")).toHaveText(/\d+/);
    await sw.click();
    await expect(page).toHaveURL(/nivel=2/);
    await expect.poll(async () => Number((await count(page).textContent())?.match(/\d+/)?.[0])).toBeGreaterThan(before);
  });

  test("RF-04: 2027-02-01 to 2027-02-10 in Colombia returns Barranquilla (deep link)", async ({ page }) => {
    await open(page, "#/explorar?pais=co&desde=2027-02-01&hasta=2027-02-10");
    const results = page.getByTestId("results");
    await expect(results.locator("[data-slug]")).toHaveCount(1);
    await expect(results.locator("[data-slug='carnaval-barranquilla']")).toBeVisible();
    await expect(count(page)).toHaveText("1 fiesta");
  });

  test("RF-04: the travel-date fields write the range into the URL", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await page.getByLabel("Desde").fill("2027-02-01");
    await expect(page).toHaveURL(/desde=2027-02-01/);
    await settled(page);
    await page.getByLabel("Hasta").fill("2027-02-10");
    await expect(page).toHaveURL(/#\/explorar\?pais=co&desde=2027-02-01&hasta=2027-02-10$/);
    await expect(page.getByTestId("results").locator("[data-slug='carnaval-barranquilla']")).toBeVisible();
  });

  test("RF-04: a festival known only by its window is labelled as a probable window", async ({ page }) => {
    await open(page, "#/explorar?pais=co&nivel=2&desde=2027-04-28&hasta=2027-04-30");
    const row = page.getByTestId("results").locator("[data-slug='festival-vallenato']");
    await expect(row).toBeVisible();
    await expect(row.locator(".tag--possible")).toHaveText("Ventana probable, sin fecha oficial");
  });

  test("an empty result always offers a way out", async ({ page }) => {
    await open(page, "#/explorar?pais=co&mes=2027-03");
    await expect(page.locator(".empty")).toBeVisible();
    const actions = page.locator(".empty__actions button, .empty__actions a");
    expect(await actions.count()).toBeGreaterThan(0);
    await actions.first().click();
    await settled(page);
    await expect(page.locator(".empty")).toHaveCount(0);
  });

  test("the bottom navigation opens Explorar on the country Inicio shows", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.getByRole("link", { name: "Explorar" }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
  });
});
