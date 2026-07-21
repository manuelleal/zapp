/**
 * scripts/probe-login-loop.js — Vigía del retorno del login SENA (read-only).
 *
 * Creado 21-jul-2026: el backend de login del SENA está flapeando (502 / "datos
 * incorrectos" falsos, verificado incluso con login manual del usuario). Este
 * script intenta el login real (scraper/auth.js → valida sesión en Moodle /my)
 * cada INTERVALO_MIN y TERMINA con exit 0 apenas funcione, para notificar que
 * Zajuna volvió. Si agota MAX_INTENTOS sale con exit 1.
 *
 * Frecuencia deliberadamente baja (20 min) para no hostigar el portal.
 * Uso: node scripts/probe-login-loop.js   (usa ZAJUNA_USER/PASS del .env)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { chromium } = require("playwright");
const { login, TIMEOUT, log } = require("../scraper/auth");

const INTERVALO_MIN = 20;
const MAX_INTENTOS = 18; // ~6 horas
// UA camuflado: el WAF del SENA bloquea "HeadlessChrome" (ver probe-waf-ua.js).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const user = process.env.ZAJUNA_USER;
  const pass = process.env.ZAJUNA_PASS;
  if (!user || !pass) { console.error("Faltan ZAJUNA_USER/ZAJUNA_PASS en .env"); process.exit(1); }

  for (let i = 1; i <= MAX_INTENTOS; i++) {
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true, locale: "es-CO", timezoneId: "America/Bogota", userAgent: UA,
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(TIMEOUT);
      await login(page, user, pass);
      console.log(`\n🟢 [${new Date().toISOString()}] ZAJUNA VOLVIÓ — login OK y sesión Moodle verificada (intento ${i}/${MAX_INTENTOS}).`);
      await browser.close();
      process.exit(0);
    } catch (e) {
      log(`Intento ${i}/${MAX_INTENTOS} falló: ${e.message.split("\n")[0]}`);
    } finally {
      await browser.close().catch(() => {});
    }
    if (i < MAX_INTENTOS) await sleep(INTERVALO_MIN * 60_000);
  }
  console.log(`\n🔴 Zajuna sigue caído tras ${MAX_INTENTOS} intentos (~${Math.round((MAX_INTENTOS * INTERVALO_MIN) / 60)} h).`);
  process.exit(1);
})();
