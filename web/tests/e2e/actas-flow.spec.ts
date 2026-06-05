import { test, expect, Page } from "@playwright/test"

// ─── Fake JWT helpers ─────────────────────────────────────────────────────────
// Builds a structurally valid JWT (header.payload.sig) whose payload the app
// can decode with atob() without needing a real secret verification.
function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/=/g, "")
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body   = b64(JSON.stringify(payload))
  return `${header}.${body}.fakesig`
}

const FAKE_JWT = makeFakeJwt({
  id:                "user-test-1",
  nombre:            "Instructor Test",
  email:             "test@zajuna.local",
  competenciaNombre: "Sistemas de Información del Servicio",
  competenciaCodigo: "228106",
  exp:               Math.floor(Date.now() / 1000) + 3600,
})

const MOCK_FICHAS   = { fichas: [{ id: "ficha-1", codigo: "3186683", nombre: "SENA Test Ficha" }] }
const MOCK_RAPS     = [{ id: "rap-1", codigo: "228106-01", descripcion: "Gestionar información" }]
const MOCK_ACTAS: unknown[] = []
const MOCK_EVIDENCIAS_ACTIVAS = { fichas: [] }
const MOCK_SCAN_STATUS = { lastAutoScanAt: null, nextAutoScanAt: null, activeCount: 0 }

async function setupMocks(page: Page) {
  await page.route("**/api/fichas**",             r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_FICHAS) }))
  await page.route("**/api/raps**",               r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_RAPS) }))
  // Only intercept GET /api/actas (list); leave POST sub-routes for individual tests
  await page.route("**/api/actas", r => {
    if (r.request().method() === "GET") {
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_ACTAS) })
    } else {
      r.continue()
    }
  })
  await page.route("**/api/evidencias/activas**", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_EVIDENCIAS_ACTIVAS) }))
  await page.route("**/api/scan/status**",        r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_SCAN_STATUS) }))
}

async function injectJwtAndGoto(page: Page, path: string) {
  // Navigate to an intermediate page first so we can set localStorage
  await page.goto("/login")
  await page.evaluate((jwt) => localStorage.setItem("zajuna_jwt", jwt), FAKE_JWT)
  await page.goto(path)
}

test.describe("Actas — flujo principal", () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page)
    await injectJwtAndGoto(page, "/actas")
  })

  test("navega a /actas y muestra encabezado", async ({ page }) => {
    await page.goto("/actas")
    await expect(page.getByText("Actas de Seguimiento")).toBeVisible()
  })

  test("botón 'Nueva Acta' abre el modal nativo", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    await expect(page.getByText("Nueva Acta de Seguimiento — Flujo Nativo")).toBeVisible()
  })

  test("Vista Previa sin campos muestra validación inline", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    // Click Vista Previa in the footer without filling the form
    await page.getByRole("button", { name: /Vista Previa/ }).last().click()
    await expect(page.getByText("Completa todos los campos obligatorios antes de previsualizar.")).toBeVisible()
  })

  test("Generar Acta Definitiva está deshabilitado antes de Vista Previa", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    const btn = page.getByRole("button", { name: /Generar Acta Definitiva/ })
    await expect(btn).toBeDisabled()
  })

  test("cerrar modal con Cancelar limpia el formulario", async ({ page }) => {
    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()
    await page.getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByText("Nueva Acta de Seguimiento — Flujo Nativo")).not.toBeVisible()
  })

  test("Vista Previa con warningsCount>0 muestra modal de advertencia al confirmar", async ({ page }) => {
    // Register the preview-native mock BEFORE any interaction
    await page.route("**/api/actas/preview-native", route =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          participantes: [{
            aprendizId: "ap1",
            nombre: "Juan Pérez",
            moodleId: null,
            juicio: "PENDIENTE",
            rapStatus: { "RAP1": "PENDIENTE" },
            hasUngraded: true,
          }],
          warningsCount: 1,
          modoPerRap: true,
        }),
      })
    )

    await page.goto("/actas")
    await page.getByRole("button", { name: "Nueva Acta" }).first().click()

    // Fill required fields
    await page.selectOption("#acta-ficha", { index: 1 }).catch(() => {})
    await page.fill("#acta-numero", "99")
    await page.fill("#acta-fecha", "2026-01-15")
    await page.fill("#acta-hora", "08:00")
    await page.fill("#acta-lugar", "Videoconferencia")
    await page.fill("#acta-objetivo", "Test objetivo")

    // Check the RAP checkbox (required for preview)
    await page.locator('input[type="checkbox"]').first().check()

    // Click Vista Previa (inline button in form body)
    await page.getByRole("button", { name: /Vista Previa/ }).first().click()

    // Wait for table to appear
    await expect(page.getByText("Juan Pérez")).toBeVisible({ timeout: 8_000 })

    // Row should be yellow (bg-yellow-50)
    const row = page.locator("tr").filter({ hasText: "Juan Pérez" })
    await expect(row).toHaveClass(/bg-yellow-50/)

    // warningsCount badge should appear
    await expect(page.getByText(/con evidencias sin calificar/)).toBeVisible()

    // Click Generar Acta Definitiva → should open warning modal
    await page.getByRole("button", { name: /Generar Acta Definitiva/ }).click()
    await expect(page.getByText("Advertencia: Evidencias sin calificar")).toBeVisible({ timeout: 3_000 })
    await expect(page.getByText(/evidencias pendientes por calificar/)).toBeVisible()
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
    await setupMocks(page)
    await injectJwtAndGoto(page, "/actas")
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
