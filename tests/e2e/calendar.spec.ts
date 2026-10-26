// RF-10: «Agregar al calendario» in two taps (Google, Apple .ics, Outlook); unconfirmed dates are
// marked in the exported event too.
import { expect, test } from "@playwright/test";
import { downloadText, open, unfold } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test.describe("Calendar sheet", () => {
  test("offers Google, Apple and Outlook", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await page.getByRole("button", { name: "Agregar al calendario" }).click(); // tap 1
    const sheet = page.getByRole("dialog", { name: "Agregar al calendario" });
    await expect(sheet).toBeVisible();

    const options = sheet.locator(".options--cal");
    const google = options.getByRole("link", { name: /^Google Calendar/ });
    await expect(google).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&.*dates=20270206\/20270210/);
    await expect(google).toHaveAttribute("rel", "noopener noreferrer");
    await expect(options.getByRole("link", { name: /^Outlook/ })).toHaveAttribute("href", /^https:\/\/outlook\.live\.com\//);
    await expect(sheet.getByRole("link", { name: /^Suscribirse en Google Calendar/ })).toHaveAttribute("href", /cid=webcal/);
    await expect(sheet.getByTestId("ics-download")).toBeVisible();
  });

  test("the Apple .ics holds the all-day dates, with an exclusive end", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await page.getByRole("button", { name: "Agregar al calendario" }).click(); // tap 1
    const { name, text } = await downloadText(page, page.getByTestId("ics-download")); // tap 2
    expect(name).toBe("carnaval-barranquilla-2027.ics");
    const ics = unfold(text);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270206");
    expect(ics).toContain("DTEND;VALUE=DATE:20270210");
    expect(ics).toMatch(/SUMMARY:Carnaval de Barranquilla/);
    expect(ics).not.toContain("[Por confirmar]");
  });

  test("a tentative date is exported with «[Por confirmar]» and the sheet says so", async ({ page }) => {
    await open(page, "#/fiesta/independencia-cartagena");
    await page.getByRole("button", { name: "Agregar al calendario" }).click();
    await expect(page.getByRole("dialog").locator(".sheet__note").first()).toContainText("[Por confirmar]");
    const { text } = await downloadText(page, page.getByTestId("ics-download"));
    const ics = unfold(text);
    expect(ics).toContain("SUMMARY:[Por confirmar] Fiestas de la Independencia de Cartagena");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261110");
    expect(ics).toContain("DTEND;VALUE=DATE:20261117");
  });

  test("closing the sheet returns focus to the button that opened it", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    const opener = page.getByRole("button", { name: "Agregar al calendario" });
    await opener.click();
    await page.getByRole("dialog").getByRole("button", { name: "Cerrar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});
