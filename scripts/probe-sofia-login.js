/**
 * scripts/probe-sofia-login.js — Verifica las credenciales contra SOFIA Plus (read-only).
 *
 * Creado 21-jul-2026: el portal Zajuna rechaza el login ("datos incorrectos" /
 * HTTP 502 intermitente) con un POST correcto. Como la contraseña de Zajuna es
 * la misma de SOFIA Plus (JOSSO SSO), probar el login en SOFIA discrimina:
 *   - SOFIA acepta  → contraseña válida → el backend de login de Zajuna está roto (SENA).
 *   - SOFIA rechaza → contraseña inválida o cuenta bloqueada → restablecer en betowa.
 *
 * Modo discovery: primero navega y lista frames/inputs (la UI de SOFIA vive en
 * iframes JOSSO); si encuentra el form, intenta el login y reporta el resultado.
 * Uso: node scripts/probe-sofia-login.js  (usa ZAJUNA_USER/PASS del .env)
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

  // URL del login JOSSO sacada del bundle de la Extensión Z (root.PiOpq-8m.js:887).
  await page.goto("http://authpre.senasofiaplus.edu.co/josso/signon/login.do?josso_back_to=http://senasofiaplus.edu.co/sofia-public/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "tmp-probe-sofia-1.png", fullPage: false });

  // ── Discovery: listar frames y sus inputs ──
  for (const f of page.frames()) {
    const inputs = await f
      .evaluate(() =>
        Array.from(document.querySelectorAll("input, select, button")).map(
          (e) => `${e.tagName.toLowerCase()}[name=${e.name || "-"}][id=${e.id || "-"}][type=${e.type || "-"}]`
        )
      )
      .catch(() => []);
    if (inputs.length) {
      console.log(`\n[FRAME] ${f.url()}`);
      for (const i of inputs.slice(0, 25)) console.log(`   ${i}`);
    }
  }

  // ── Buscar el frame con input de password e intentar login ──
  let hecho = false;
  for (const f of page.frames()) {
    const passInput = f.locator('input[type="password"]').first();
    if ((await passInput.count().catch(() => 0)) === 0) continue;

    console.log(`\n[LOGIN] Intentando en frame: ${f.url()}`);
    // SOFIA: select de tipo doc + input usuario + input password.
    const sel = f.locator("select").first();
    if ((await sel.count()) > 0) {
      // Elegir la opción de Cédula de Ciudadanía si existe.
      const opciones = await sel.locator("option").allTextContents();
      const idx = opciones.findIndex((o) => /c[ée]dula de ciudadan/i.test(o));
      if (idx >= 0) await sel.selectOption({ index: idx });
      console.log(`   → opciones tipo doc: ${JSON.stringify(opciones)}`);
    }
    const textInputs = f.locator('input[type="text"], input[type="number"]');
    if ((await textInputs.count()) > 0) await textInputs.first().fill(user);
    await passInput.fill(pass);
    await page.screenshot({ path: "tmp-probe-sofia-2-form.png", fullPage: false });

    const boton = f.locator('input[type="submit"], button[type="submit"], button:has-text("Ingresar"), input[value*="ngresar"]').first();
    await boton.click({ force: true }).catch((e) => console.log(`   → clic falló: ${e.message.split("\n")[0]}`));
    await page.waitForTimeout(12_000);
    hecho = true;
    break;
  }

  await page.screenshot({ path: "tmp-probe-sofia-3-post.png", fullPage: true });
  console.log(`\n[FIN] hecho=${hecho} URL final: ${page.url()}`);
  const texto = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500)).catch(() => "(?)");
  console.log(`[FIN] Texto visible: ${texto}`);
  await browser.close();
})().catch((e) => { console.error(`PROBE FALLÓ: ${e.message}`); process.exit(1); });
