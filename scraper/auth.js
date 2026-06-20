/**
 * scraper/auth.js — Login SSO de SENA en Zajuna (Moodle).
 *
 * IMPORTANTE — Por qué el login es especial:
 *   Zajuna NO usa el login nativo de Moodle (/login/index.php + usuario/clave).
 *   El acceso pasa por el portal raíz (https://zajuna.sena.edu.co) con un SSO
 *   federado propio del SENA: formulario con `typeDocument` (CC/TI/…), `document`
 *   (número de cédula) y `password` del SOFIA Plus. El usuario Moodle NO tiene
 *   contraseña interna, por eso /login/token.php responde `invalidlogin` aunque las
 *   credenciales sean correctas. No se puede obtener un token WS.
 *   → Consecuencia: TODO el scraping se hace en sesión Playwright (cookies de
 *     sesión SSO). Los fetch en Node.js se hacen a partir del storageState de esa
 *     sesión (ver lib/sessionStore.js). Ver CLAUDE.md §11.2 para el detalle.
 *
 * cerrarModal:
 *   #connection-guard-modal aparece aleatoriamente en cualquier navegación de Zajuna
 *   (modal de "sesión duplicada / conexión perdida"). Si no se cierra bloquea clicks
 *   y selectores en la página. Se intenta cerrarlo primero por botón y, si persiste,
 *   se oculta vía JS directo. Es silencioso (no lanza si no está).
 *
 * Detección de credenciales incorrectas:
 *   SENA NO usa `.loginerrors`/`.alert-danger` de Moodle. Cuando la cédula o la
 *   clave son inválidas el portal redirige a /index.php?error=Los+datos+de+acceso…
 *   Sin verificar esa URL, login() reportaría "Sesión iniciada ✓" en falso y el
 *   scrape devolvería 0 notas silenciosamente (confirmado en log real 18-jun-2026).
 *
 * Exporta: { login, cerrarModal, BASE_URL, TIMEOUT, log }
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
  const urlPostLogin = page.url();
  log(`URL post-login: ${urlPostLogin}`);

  // Detección de credenciales incorrectas — SENA NO usa los selectores nativos de
  // Moodle (.loginerrors/.alert-danger). Cuando el documento/clave son inválidos
  // (caso típico: "Sofía obligó a rotar la clave" y la guardada quedó vieja) el
  // portal redirige a /index.php?error=Los+datos+de+acceso+son+incorrectos...
  // Sin esta verificación, login() reportaba "Sesión iniciada ✓" en falso y luego
  // el scrape leía 0 notas por redirección. (Confirmado en log real 18-jun-2026.)
  let urlDecodificada = urlPostLogin;
  try { urlDecodificada = decodeURIComponent(urlPostLogin); } catch { /* URL malformada */ }
  if (/[?&]error=/i.test(urlPostLogin) || /datos\s+de\s+acceso\s+son\s+incorrectos/i.test(urlDecodificada)) {
    throw new Error("Credenciales incorrectas.");
  }

  const hayError = await page
    .locator(".loginerrors, .alert-danger")
    .isVisible()
    .catch(() => false);
  if (hayError) throw new Error("Credenciales incorrectas.");
  log("Sesión iniciada ✓");
}

module.exports = { login, cerrarModal, BASE_URL, TIMEOUT, log };
