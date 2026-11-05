// The «today» the app counts from: the ?today= test hook is never silent (SEC-13), and without
// it the date follows the device clock across local midnight without a reload (code-F11).
import { expect, test } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test("a ?today= link says the date is simulated and offers the real one", async ({ page }) => {
  await open(page, "#/pais/co");
  const banner = page.getByTestId("today-override");
  await expect(banner).toContainText("Fecha simulada: 26 oct 2026");
  await banner.getByRole("link", { name: "Usar la fecha de hoy" }).click();
  await expect(page).not.toHaveURL(/today=/);
  await expect(page).toHaveURL(/#\/pais\/co$/);
  await settled(page);
  await expect(page.getByTestId("today-override")).toHaveCount(0);
});

test("countdowns move on at local midnight in an app left open", async ({ page }) => {
  // America/Lima (playwright.config timezoneId): one minute before midnight on 26 Oct 2026.
  await page.clock.install({ time: new Date("2026-10-26T23:59:00-05:00") });
  await page.goto("/#/pais/co");
  await settled(page);
  await expect(page.getByTestId("today-override")).toHaveCount(0);
  const number = page.getByTestId("next-festival").locator(".countdown__number");
  const before = Number(await number.textContent());
  expect(before).toBeGreaterThan(1);
  await page.clock.runFor("02:00");
  await expect(number).toHaveText(String(before - 1));
});

test("the midnight re-render keeps the reader's place on a ficha (UI-3)", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-26T23:59:00-05:00") });
  await page.goto("/#/fiesta/carnaval-barranquilla");
  await settled(page);
  await page.evaluate(() => window.scrollTo(0, 700));
  expect(await page.evaluate(() => window.scrollY)).toBe(700);
  const countdown = page.locator(".when [data-countdown]");
  const before = await countdown.textContent();
  await page.clock.runFor("02:00");
  await expect(countdown).not.toHaveText(before ?? "");
  await settled(page);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - 700)).toBeLessThanOrEqual(2);
});
