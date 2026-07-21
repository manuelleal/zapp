/**
 * scripts/probe-login-manual.js — El USUARIO loguea a mano; el probe intercepta (read-only).
 *
 * Creado 21-jul-2026: el login automatizado recibe "datos incorrectos" 3/3 con
 * un POST perfecto, pero el usuario dice que SÍ entra a mano con esa clave.
 * Este probe abre un browser VISIBLE, NO llena nada, y espera (hasta 8 min) a
 * que el usuario haga el login él mismo. Intercepta el POST a singIn.php y:
 *   - lista los CAMPOS enviados (¿el submit humano lleva campos extra?),
 *   - compara la contraseña tecleada contra ZAJUNA_PASS del .env SIN mostrarla
 *     (solo dice si coincide, y largo/primeros/últimos 2 chars),
 *   - reporta la respuesta del server (302 a error vs login exitoso),
 *   - si entra, verifica la sesión Moodle en /my.
 *
 * Uso: node scripts/probe-login-manual.js   (el usuario debe estar en la máquina)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { chromium } = require("playwright");

const ESPERA_MAX_MS = 8 * 60_000;
const BASE_URL = "https://zajuna.sena.edu.co/zajuna";

(async () => {
  const passEnv = process.env.ZAJUNA_PASS || "";

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(ESPERA_MAX_MS);

  let exito = false;

  page.on("request", (req) => {
    if (!/singIn\.php/i.test(req.url())) return;
    const body = req.postData() || "";
    const params = new URLSearchParams(body);
    const campos = Array.from(params.keys());
    const pwd = params.get("password") || "";
    console.log(`\n[REQ] POST singIn.php`);
    console.log(`      campos enviados: ${JSON.stringify(campos)}`);
    console.log(`      document: ${params.get("document")}  typeDocument: ${params.get("typeDocument")}`);
    console.log(`      password: [len=${pwd.length}: ${pwd.slice(0, 2)}...${pwd.slice(-2)}]`);
    console.log(`      ¿password idéntica a ZAJUNA_PASS del .env?: ${pwd === passEnv ? "SÍ ✓" : "NO ✗ — ahí está la diferencia"}`);
    if (pwd !== passEnv) {
      console.log(`      (la del .env tiene len=${passEnv.length}: ${passEnv.slice(0, 2)}...${passEnv.slice(-2)})`);
    }
  });
  page.on("response", (res) => {
    if (!/singIn\.php/i.test(res.url())) return;
    const loc = res.headers()["location"] || "";
    console.log(`[RES] HTTP ${res.status()}${loc ? `  → ${loc}` : ""}`);
    if (res.status() >= 500) console.log("      (5xx: el backend del SENA falló en este intento — reintenta en la misma ventana)");
  });

  console.log("Navegador abierto. HAGA EL LOGIN A MANO (tipo doc + documento + contraseña).");
  console.log(`Espero hasta ${ESPERA_MAX_MS / 60000} min. Si el portal da 502, reintente en la misma ventana.`);
  await page.goto("https://zajuna.sena.edu.co", { waitUntil: "load" });

  // Esperar a que la URL salga del portal raíz sin error (indicio de login OK).
  const inicio = Date.now();
  while (Date.now() - inicio < ESPERA_MAX_MS) {
    await page.waitForTimeout(2000);
    const url = page.url();
    if (/[?&]error=/i.test(url)) continue; // rechazo: el usuario puede reintentar
    if (!/zajuna\.sena\.edu\.co\/?(index\.php)?$/i.test(url.split("?")[0])) {
      // Salió del portal raíz: probable login OK.
      exito = true;
      break;
    }
  }

  if (exito) {
    console.log(`\n[POST-LOGIN] URL: ${page.url()}`);
    await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const enMoodle = /\/my/.test(page.url());
    console.log(`[VERIFICACIÓN] goto ${BASE_URL}/my/ → ${page.url()}`);
    console.log(`[VERIFICACIÓN] ¿Sesión Moodle real?: ${enMoodle ? "SÍ ✓ — el login manual FUNCIONA en este mismo browser" : "NO ✗ — entró al portal pero Moodle no dio sesión (handoff SSO roto)"}`);
  } else {
    console.log("\n[FIN] No se detectó login exitoso en el tiempo de espera.");
  }

  await page.screenshot({ path: "tmp-probe-manual-final.png", fullPage: false }).catch(() => {});
  await browser.close();
})().catch((e) => { console.error(`PROBE FALLÓ: ${e.message}`); process.exit(1); });
