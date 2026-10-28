// SEC-16: the Content-Security-Policy ships as a build-time meta tag (GitHub Pages sends no custom
// headers, so frame-ancestors is out of reach). The tests pin its directives and check that no
// screen trips it, so dropping the plugin or adding an inline style fails here.
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test("the built page carries the CSP meta with the expected directives", async ({ page }) => {
  await open(page, "#/");
  const content = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")) ?? "";
  const directives = new Map(
    content
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name = "", ...values]) => [name, values.join(" ")]),
  );
  for (const name of ["default-src", "img-src", "style-src", "script-src", "connect-src", "font-src", "base-uri"]) expect(directives.get(name), name).toBe("'self'");
  expect(directives.get("form-action")).toBe("'none'");
  expect(content).not.toMatch(/unsafe-inline|unsafe-eval|data:|\*/);
});

test("no screen triggers a CSP violation", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  for (const hash of ["#/pais/co", "#/explorar?pais=co", "#/fiesta/carnaval-barranquilla", "#/ajustes", "#/datos", "#/guardadas"]) {
    await open(page, hash);
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations), hash).toEqual([]);
  }
  await open(page, "#/fiesta/carnaval-barranquilla");
  await page.getByRole("button", { name: "Agregar al calendario" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
});
