// The calendar lists parties (2026-11-09): a solemn act never shows, types name kinds of party, and
// the score says how much people dance and how far they travel for it.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { A11Y_TAGS, filterChips, open, openFilters } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test.describe("Parties only", () => {
  test("a procession the classifier found solemn is in no list and has no ficha", async ({ page }) => {
    await open(page, "#/explorar?pais=pe&nivel=2");
    await expect(page.locator("main")).toContainText("Carnaval de Cajamarca");
    await expect(page.locator("main")).not.toContainText("Señor de los Milagros");
    await open(page, "#/explorar?pais=br&nivel=2");
    await expect(page.locator("main")).not.toContainText("Círio de Nazaré");
    await open(page, "#/fiesta/senor-de-los-milagros");
    await expect(page.locator(".empty__actions a").first()).toBeVisible();
  });

  test("the type chips name kinds of party, not religious or seasonal categories", async ({ page }) => {
    await open(page, "#/explorar?pais=co,br,pe");
    await openFilters(page);
    const chips = filterChips(page);
    for (const label of ["Carnaval", "Música", "Danza", "Fiesta popular"]) await expect(chips.getByRole("button", { name: new RegExp(`^${label}\\b`) }).first()).toBeVisible();
    await expect(chips).not.toContainText("Tradición religiosa");
    await expect(chips).not.toContainText("Cosecha o temporada");
  });

  test("a ficha shows how much people dance there and where they come from, with the AI's source", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const party = page.locator(".crit").filter({ hasText: "Baile y fiesta" });
    await expect(party).toContainText("Se baila en la calle");
    await expect(page.locator(".crit").filter({ hasText: "Gente de fuera" })).toContainText("otros países");
    await expect(page.locator(".crit")).toHaveCount(5);
    expect((await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze()).violations).toEqual([]);
  });

  test("Sobre los datos explains the party score and why solemn acts are left out", async ({ page }) => {
    await open(page, "#/datos");
    const criteria = page.locator(".criteria");
    await expect(criteria).toContainText("Baile y fiesta");
    await expect(criteria).toContainText("Gente de fuera");
    await expect(criteria).not.toContainText("Reconocimiento");
    await expect(criteria).not.toContainText("Acto solemne");
    await expect(page.locator(".tiers")).toContainText("procesiones, peregrinaciones");
  });
});
