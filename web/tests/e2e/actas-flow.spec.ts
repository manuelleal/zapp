import { test, expect, Page } from "@playwright/test"

const EMAIL    = process.env.E2E_EMAIL    || "test@test.com"
const PASSWORD = process.env.E2E_PASSWORD || "test1234"

async function login(page: Page) {
  await page.goto("/login")
  await page.fill('input[type="email"]',    EMAIL)
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL("**/dashboard", { timeout: 10_000 })
}

test.describe("Actas — flujo principal", () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test("navega a /actas y muestra encabezado", async ({ page }) => {
    await page.goto("/actas")
    await expect(page.getByText("Actas de Seguimiento")).toBeVisible()
  })

  test("botón 'Nueva Acta' abre el modal", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    await expect(page.getByText("Nueva Acta de Seguimiento")).toBeVisible()
  })

  test("formulario vacío muestra validación inline", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    await page.getByRole("button", { name: "Crear Acta" }).click()
    await expect(page.getByText("Completa todos los campos obligatorios.")).toBeVisible()
  })

  test("cerrar modal con Cancelar limpia el formulario", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    await page.getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByText("Nueva Acta de Seguimiento")).not.toBeVisible()
  })

  test("botón Word muestra spinner mientras descarga", async ({ page }) => {
    await page.goto("/actas")
    const wordBtn = page.getByRole("button", { name: /Word/ }).first()
    if (await wordBtn.count() === 0) {
      test.skip()
      return
    }
    // intercept the download request to delay it so we can observe the spinner
    await page.route("**/api/actas/*/download", async route => {
      await new Promise(r => setTimeout(r, 1500))
      await route.continue()
    })
    await wordBtn.click()
    // spinner SVG should appear while the fetch is in flight
    await expect(wordBtn.locator("svg.animate-spin")).toBeVisible({ timeout: 3000 })
  })
})

test.describe("Actas — resiliencia de errores", () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test("muestra toast de error si la descarga Word falla", async ({ page }) => {
    await page.goto("/actas")
    const wordBtn = page.getByRole("button", { name: /Word/ }).first()
    if (await wordBtn.count() === 0) {
      test.skip()
      return
    }
    await page.route("**/api/actas/*/download", route =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: "Error generando el documento." }) })
    )
    await wordBtn.click()
    await expect(page.getByText("Error generando el documento.")).toBeVisible({ timeout: 5000 })
  })
})
