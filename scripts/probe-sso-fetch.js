/**
 * scripts/probe-sso-fetch.js — Probe de diagnóstico del SSO de Zajuna (read-only).
 *
 * Creado durante el mantenimiento del SENA del 9-13 jul 2026 (plan 012). Sirve
 * para responder "¿Zajuna volvió? ¿el problema es nuestro o del SENA?" en 2 min.
 * Reproduce el flujo exacto de leerConfigLoteWorker para aislar dónde se rompe:
 *   1. Login SSO con Chromium (como el worker).
 *   2. Navegar a /my/ EN EL BROWSER → ¿el browser sí tiene sesión Moodle?
 *   3. Extraer cookies (cookieHeaderFromState, el mismo helper del worker) y
 *      pedir /my/ por fetch de Node → ¿el fetch rebota al portal?
 *
 * Interpretación:
 *   - Browser /my OK + fetch /my rebota  → SENA bloquea fetch de Node (WAF/handshake JS).
 *   - Browser /my TAMBIÉN rebota         → el handoff SSO→Moodle está roto (cambio del SENA).
 *
 * Read-only: no escribe DB ni modifica nada en Moodle. Deja capturas tmp-probe-*.png.
 * OJO: hace login real → puede expulsar la sesión Zajuna activa de esa cuenta.
 * Uso: node scripts/probe-sso-fetch.js  (usa ZAJUNA_USER/PASS del .env)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { chromium } = require("playwright");
const { Agent } = require("undici");
const { login, BASE_URL, log } = require("../scraper/auth");
const { cookieHeaderFromState } = require("../scraper/configEvidenciasFetch");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

async function fetchDiag(url, cookieStr, redirect) {
  const res = await fetch(url, {
    headers: { Cookie: cookieStr, "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect,
    dispatcher: insecureAgent,
  });
  return res;
}

(async () => {
  const user = process.env.ZAJUNA_USER;
  const pass = process.env.ZAJUNA_PASS;
  if (!user || !pass) { console.error("Faltan ZAJUNA_USER/ZAJUNA_PASS en .env"); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);

  try {
    // ── 0. Login MANUAL paso a paso (mismos selectores de auth.js) con capturas,
    //       porque login() reporta "Sesión iniciada ✓" aunque el clic no navegue
    //       (waitForFunction con timeout tragado). Queremos VER qué muestra el
    //       portal después del clic: ¿captcha? ¿error? ¿mensaje de mantenimiento? ──
    await page.goto("https://zajuna.sena.edu.co", { waitUntil: "load" });
    await page.screenshot({ path: "tmp-probe-1-portal.png", fullPage: false });

    await page.locator('select[name="typeDocument"]').selectOption("CC");
    await page.locator('input[name="document"]').fill(user);
    await page.locator('input[name="password"]').first().fill(pass);
    await page.screenshot({ path: "tmp-probe-2-form-lleno.png", fullPage: false });

    await page.locator('button[name="form_login_user"]').click({ force: true });
    console.log("[0] Clic en login hecho; esperando 15 s para ver la respuesta del portal...");
    await page.waitForTimeout(15_000);
    await page.screenshot({ path: "tmp-probe-3-post-click.png", fullPage: true });
    console.log(`    → URL 15s después del clic: ${page.url()}`);

    // Texto visible de alertas/modales comunes (SweetAlert, toasts, alerts).
    const alertas = await page.evaluate(() => {
      const sel = ".swal2-popup, [role=alert], .alert, .toast, .error, .mensaje, #connection-guard-modal";
      return Array.from(document.querySelectorAll(sel))
        .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300))
        .filter(Boolean);
    });
    console.log(`    → Alertas visibles: ${alertas.length ? JSON.stringify(alertas, null, 2) : "(ninguna)"}`);
    const cuerpoPortal = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 600));
    console.log(`    → Texto visible (600 chars): ${cuerpoPortal}`);
    console.log(`\n[1] POST-LOGIN URL: ${page.url()}`);

    // ── 2. ¿El BROWSER tiene sesión Moodle? ──
    await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded" });
    const browserUrl = page.url();
    const browserTitle = await page.title().catch(() => "(sin título)");
    console.log(`[2] BROWSER goto ${BASE_URL}/my/`);
    console.log(`    → URL final:  ${browserUrl}`);
    console.log(`    → Título:     ${browserTitle}`);
    console.log(`    → ¿En Moodle /my?: ${/\/my/.test(browserUrl) ? "SÍ ✓" : "NO ✗ (rebotado)"}`);

    // ── 3. Cookies del contexto → fetch de Node (igual que el worker) ──
    const state = await ctx.storageState();
    const nombres = (state.cookies || [])
      .filter((c) => /zajuna|sena/i.test(c.domain || ""))
      .map((c) => `${c.name}@${c.domain}${c.path}`);
    console.log(`\n[3] Cookies zajuna/sena en storageState (${nombres.length}):`);
    for (const n of nombres) console.log(`    - ${n}`);

    const cookieStr = cookieHeaderFromState(state);

    // 3a. Sin seguir redirects: ver el PRIMER salto que da Moodle al fetch.
    const rManual = await fetchDiag(`${BASE_URL}/my/`, cookieStr, "manual");
    console.log(`\n[3a] FETCH ${BASE_URL}/my/ (redirect=manual)`);
    console.log(`    → HTTP ${rManual.status}  Location: ${rManual.headers.get("location") || "(ninguno)"}`);

    // 3b. Siguiendo redirects: dónde termina (lo que ve el worker).
    const rFollow = await fetchDiag(`${BASE_URL}/my/`, cookieStr, "follow");
    const cuerpo = await rFollow.text();
    console.log(`[3b] FETCH ${BASE_URL}/my/ (redirect=follow)`);
    console.log(`    → HTTP ${rFollow.status}  URL final: ${rFollow.url}`);
    console.log(`    → ¿Terminó en Moodle /my?: ${/\/my/.test(rFollow.url) ? "SÍ ✓" : "NO ✗ (rebotado — mismo síntoma del worker)"}`);
    console.log(`    → Tamaño HTML: ${cuerpo.length} bytes`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(`\nPROBE FALLÓ: ${e.message}`); process.exit(1); });
