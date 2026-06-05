/**
 * scraper/auth.js — login compartido para todos los scrapers
 */

const BASE_URL = "https://zajuna.sena.edu.co/zajuna";
const TIMEOUT  = 90_000;

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

async function cerrarModal(page) {
  try {
    const modal = page.locator("#connection-guard-modal");
    const visible = await modal.isVisible({ timeout: 4000 }).catch(() => false);
    if (!visible) return;
    log("Modal detectado, cerrando...");
    await modal.locator("button").last().click({ force: true });
    await page.waitForTimeout(800);
    const sigueVisible = await modal.isVisible({ timeout: 1000 }).catch(() => false);
    if (sigueVisible) {
      await page.evaluate(() => {
        const m = document.getElementById("connection-guard-modal");
        if (m) m.style.display = "none";
      });
    }
    log("Modal cerrado.");
  } catch (e) {
    log(`cerrarModal: ${e.message}`);
  }
}

async function login(page, user, pass) {
  log("Abriendo Zajuna...");
  await page.goto("https://zajuna.sena.edu.co", { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  await page.locator('select[name="typeDocument"]').selectOption("CC");
  log("Tipo documento: CC.");

  await page.locator('input[name="document"]').fill(user);
  log("Documento ingresado.");

  await page.locator('input[name="password"]').first().fill(pass);
  log("Contraseña ingresada.");

  await cerrarModal(page);

  await page.locator('button[name="form_login_user"]').click({ force: true });
  log("Botón login clickeado.");

  await page
    .waitForFunction(
      () =>
        !window.location.href.includes("zajuna.sena.edu.co") ||
        window.location.pathname !== "/",
      { timeout: TIMEOUT }
    )
    .catch(() => {});

  await cerrarModal(page);
  log(`URL post-login: ${page.url()}`);

  const hayError = await page
    .locator(".loginerrors, .alert-danger")
    .isVisible()
    .catch(() => false);
  if (hayError) throw new Error("Credenciales incorrectas.");
  log("Sesión iniciada ✓");
}

module.exports = { login, cerrarModal, BASE_URL, TIMEOUT, log };
