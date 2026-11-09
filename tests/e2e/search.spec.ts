// RF-02: scope selector with tolerant country search and the three most recent countries on top.
import { expect, test } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test.describe("Scope selector", () => {
  test("RF-02: «brazil» finds Brasil at the first try", async ({ page }) => {
    await open(page, "#/");
    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    const dialog = page.getByRole("dialog", { name: "¿Dónde quieres ver fiestas?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "Buscar un país o una fiesta" })).toBeFocused();
    await page.keyboard.type("brazil");
    await expect(dialog.getByTestId("country-results").getByRole("link").first()).toContainText("Brasil");
  });

  for (const query of ["peru", "Perú", "Peru"]) {
    test(`RF-02: «${query}» lists Perú first`, async ({ page }) => {
      await open(page, "#/");
      await page.getByRole("button", { name: /\(cambiar\)/ }).click();
      await page.getByRole("searchbox").fill(query);
      await expect(page.getByTestId("country-results").getByRole("link").first()).toContainText("Perú");
    });
  }

  test("RF-02: picking a country opens its Inicio and it becomes a recent country", async ({ page }) => {
    await open(page, "#/");
    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    await page.getByRole("searchbox").fill("colombia");
    await page.getByTestId("country-results").getByRole("link", { name: /Colombia/ }).first().click();
    await expect(page).toHaveURL(/#\/pais\/co$/);
    await settled(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Colombia");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    const recent = page.getByRole("dialog").locator(".scope__group", { hasText: "Recientes" });
    await expect(recent).toBeVisible();
    await expect(page.locator("[data-key='recent-CO']")).toBeVisible();
  });

  test("RF-02: festivals are searchable by name and city", async ({ page }) => {
    await open(page, "#/");
    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    await page.getByRole("searchbox").fill("barranquilla");
    await page.getByRole("dialog").getByRole("link", { name: /Carnaval de Barranquilla/ }).click();
    await expect(page).toHaveURL(/#\/fiesta\/carnaval-barranquilla$/);
  });

  test("Escape closes the sheet and returns focus to the scope button", async ({ page }) => {
    await open(page, "#/pais/co");
    const opener = page.getByRole("button", { name: /\(cambiar\)/ });
    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a country without data offers to build it: the build-country form with its code", async ({ page }) => {
    await open(page, "#/pais/jp");
    await expect(page.getByTestId("unbuilt")).toHaveAttribute("data-build", "none");
    await expect(page.locator(".empty")).toContainText("Japón todavía no está en el calendario");
    const build = page.locator(".empty__actions").getByRole("link", { name: /Construir Japón/ });
    await expect(build).toBeVisible();
    const href = new URL((await build.getAttribute("href"))!);
    expect(href.pathname).toMatch(/\/issues\/new$/);
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ template: "build-country.yml", title: "Build: JP", country: "JP" });
  });

  test("a requested country says it is being built instead of offering the button again", async ({ page }) => {
    await open(page, "#/pais/bo");
    await expect(page.getByTestId("unbuilt")).toHaveAttribute("data-build", "queued");
    await expect(page.locator(".empty")).toContainText("Estamos construyendo Bolivia");
    await expect(page.locator(".empty__actions").getByRole("link", { name: /Construir/ })).toHaveCount(0);
    await page.getByRole("button", { name: /\(cambiar\)/ }).click();
    await page.getByRole("searchbox").fill("bolivia");
    await expect(page.getByTestId("country-results").getByRole("link", { name: /Bolivia/ })).toContainText("En construcción");
  });
});
