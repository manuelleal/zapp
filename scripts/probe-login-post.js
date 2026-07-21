/**
 * scripts/probe-login-post.js — Intercepta el POST de login al portal SENA (read-only).
 *
 * Creado 21-jul-2026: el portal responde "Los datos de acceso son incorrectos"
 * al login automatizado incluso con la contraseña nueva. Este probe abre un
 * browser VISIBLE (headed pasa el WAF), llena el formulario como auth.js y
 * registra el POST exacto a singIn.php (campos enviados, password enmascarada)
 * y la respuesta del servidor. Así se discrimina:
 *   - POST con valores correctos + rechazo del server → cuenta/contraseña (SENA).
 *   - POST con valores mutilados/vacíos             → bug nuestro al llenar.
 *
 * Uso: node scripts/probe-login-post.js  (usa ZAJUNA_USER/PASS del .env)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { chromium } = require("playwright");

(async () => {
  const user = process.env.ZAJUNA_USER;
  const pass = process.env.ZAJUNA_PASS;
  if (!user || !pass) { console.error("Faltan ZAJUNA_USER/ZAJUNA_PASS en .env"); process.exit(1); }

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  page.on("request", (req) => {
    if (/singIn\.php|login_user/i.test(req.url())) {
      const body = req.postData() || "(sin body)";
      // Enmascarar la contraseña: mostrar largo y primeros/últimos 2 chars.
      const masked = body.replace(/(password=)([^&]*)/i, (_, k, v) => {
        const dec = decodeURIComponent(v);
        return `${k}[len=${dec.length}: ${dec.slice(0, 2)}...${dec.slice(-2)}]`;
      });
      console.log(`\n[REQ] ${req.method()} ${req.url()}`);
      console.log(`      body: ${masked}`);
    }
  });
  page.on("response", (res) => {
    if (/singIn\.php|login_user|index\.php\?error/i.test(res.url())) {
      console.log(`[RES] ${res.status()} ${res.url()}`);
      const loc = res.headers()["location"];
      if (loc) console.log(`      location: ${loc}`);
    }
  });

  await page.goto("https://zajuna.sena.edu.co", { waitUntil: "load" });
  await page.locator('select[name="typeDocument"]').selectOption("CC");
  await page.locator('input[name="document"]').fill(user);
  await page.locator('input[name="password"]').first().fill(pass);

  // Verificar qué quedó REALMENTE en los inputs (por si algún JS los mutila).
  const vals = await page.evaluate(() => {
    const f = document.querySelector("#login__form-cursos");
    const doc = f?.querySelector('input[name="document"]')?.value || "";
    const pwd = f?.querySelector('input[name="password"]')?.value || "";
    const type = f?.querySelector('select[name="typeDocument"]')?.value || "";
    return { type, doc, pwdLen: pwd.length, pwdIni: pwd.slice(0, 2), pwdFin: pwd.slice(-2) };
  });
  console.log(`[DOM] typeDocument=${vals.type} document=${vals.doc} password=[len=${vals.pwdLen}: ${vals.pwdIni}...${vals.pwdFin}]`);

  await page.locator('button[name="form_login_user"]').click({ force: true });
  await page.waitForTimeout(12_000);
  console.log(`\n[FIN] URL final: ${page.url()}`);
  await page.screenshot({ path: "tmp-probe-login-post.png", fullPage: false });
  await browser.close();
})().catch((e) => { console.error(`PROBE FALLÓ: ${e.message}`); process.exit(1); });
