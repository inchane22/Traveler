// Inicio: RF-01 «Lo próximo», RF-05 timeline with an equivalent list, RF-13 freshness and stale notice.
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

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
    await expect(hero).toContainText("Tentativa");
    await expect(hero).toContainText("Patrón");
  });

  test("RF-05: the 12-month timeline is an ordered list of links with dates and status in their names", async ({ page }) => {
    await open(page, "#/pais/co");
    const rows = page.locator(".tl-rows > li");
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    const first = rows.first().getByRole("link");
    await expect(first).toHaveAccessibleName(/Cartagena.*Fiesta nacional.*10–16 nov 2026.*Tentativa/);
    await expect(page.locator(".tl-axis")).toHaveAttribute("aria-hidden", "true");
  });

  test("RF-05: the Nivel 2 switch lives in the URL", async ({ page }) => {
    await open(page, "#/pais/co");
    const sw = page.getByRole("switch", { name: "Incluir Nivel 2" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(page).toHaveURL(/#\/pais\/co\?nivel=2$/);
    await expect(page.getByRole("switch", { name: "Incluir Nivel 2" })).toHaveAttribute("aria-checked", "true");
  });

  test("RF-13: shows when the data was verified, and a stale notice after 30 days", async ({ page }) => {
    await open(page, "#/pais/co");
    await expect(page.locator(".freshness").first()).toContainText("Verificado hoy");
    await expect(page.locator(".notice--warn")).toHaveCount(0);

    await open(page, "#/pais/co", "2026-12-15");
    await expect(page.locator(".notice--warn")).toContainText("se verificaron por última vez el 26 oct 2026");
  });

  test("RF-13: Colombia's partial source coverage is flagged", async ({ page }) => {
    await open(page, "#/pais/co");
    await expect(page.locator(".freshness--partial")).toContainText("Cobertura parcial");
  });

  test("offers webcal, Google and Outlook subscriptions for the country", async ({ page }) => {
    await open(page, "#/pais/co");
    const block = page.locator(".subscribe");
    await expect(block.getByRole("link", { name: "Suscribirse en Apple Calendar u Outlook" })).toHaveAttribute("href", /^webcal:\/\/.+\/calendars\/co\.ics$/);
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
