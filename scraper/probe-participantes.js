/**
 * scraper/probe-participantes.js — Sonda de exploración del DOM real de Zajuna.
 *
 * USO (manual, NO se ejecuta en producción):
 *
 *   1. Asegúrate de tener ZAJUNA_USER y ZAJUNA_PASS en tu .env.
 *   2. Necesitas el `courseId` Moodle de una ficha real. Lo encuentras en
 *      Prisma Studio (Ficha.courseId) o en `npx prisma studio`.
 *   3. Ejecuta:
 *        node scraper/probe-participantes.js <courseId>
 *      Por defecto corre con --no-headless para que veas qué pasa.
 *      Agrega --headless si quieres correrlo sin ver el navegador.
 *
 * QUÉ HACE:
 *   - Login a Zajuna.
 *   - Navega a /user/index.php?id=<courseId>&perpage=5000.
 *   - Imprime: cantidad de filas detectadas con CADA selector candidato,
 *     headers de las columnas, primeras 3 filas como JSON.
 *   - Vuelca el HTML a probe-participantes.html para inspección manual.
 *
 * Útil cuando los selectores de scraper/mensajes.js no funcionan en algún
 * curso y necesitas ver qué markup está devolviendo Zajuna.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { login, BASE_URL, cerrarModal } = require("./auth");
const { extraerParticipantesDelDOM } = require("./mensajes");

const courseId = process.argv[2];
const headless = process.argv.includes("--headless");

if (!courseId) {
  console.error("ERROR: falta courseId. Uso: node scraper/probe-participantes.js <courseId> [--headless]");
  process.exit(1);
}

const ZAJUNA_USER = process.env.ZAJUNA_USER;
const ZAJUNA_PASS = process.env.ZAJUNA_PASS;
if (!ZAJUNA_USER || !ZAJUNA_PASS) {
  console.error("ERROR: falta ZAJUNA_USER y/o ZAJUNA_PASS en .env");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);

  try {
    await login(page, ZAJUNA_USER, ZAJUNA_PASS);

    const url = `${BASE_URL}/user/index.php?id=${courseId}&perpage=5000`;
    console.log(`\n→ Navegando a: ${url}\n`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await cerrarModal(page).catch(() => {});
    await page.waitForTimeout(2000); // dar tiempo a que cargue scripts

    // ── 1. Diagnóstico: contar filas con cada selector candidato ─────────────
    const SELECTORES = [
      "table#participants tbody tr",
      "table.userlist tbody tr",
      "table.generaltable tbody tr",
      "table.flexible tbody tr",
      "tr[data-userid]",
      "form#participantsform table tbody tr",
      "div.userlist table tbody tr",
      // Genéricos
      "table tbody tr",
      "table tr",
    ];
    const conteos = await page.evaluate((sels) => {
      const out = {};
      for (const s of sels) out[s] = document.querySelectorAll(s).length;
      return out;
    }, SELECTORES);

    console.log("=== CONTEOS POR SELECTOR ===");
    for (const [s, n] of Object.entries(conteos)) {
      console.log(`  ${n.toString().padStart(4)}  ${s}`);
    }

    // ── 2. Headers de la primera tabla ───────────────────────────────────────
    const headers = await page.evaluate(() => {
      const tabla = document.querySelector("table");
      if (!tabla) return [];
      const ths = tabla.querySelectorAll("thead th, thead td");
      return Array.from(ths).map(h => ({
        texto: (h.textContent || "").trim(),
        className: h.className,
        id: h.id,
      }));
    });
    console.log("\n=== HEADERS DE LA PRIMERA TABLA ===");
    console.log(JSON.stringify(headers, null, 2));

    // ── 3. Primera fila completa (raw HTML truncado) ─────────────────────────
    const filaSample = await page.evaluate(() => {
      const fila = document.querySelector("table tbody tr");
      if (!fila) return null;
      return {
        outerHTML: fila.outerHTML.substring(0, 2000),
        attributes: Array.from(fila.attributes).map(a => `${a.name}="${a.value}"`).join(" "),
        celdasCount: fila.querySelectorAll("td, th").length,
        celdasTexto: Array.from(fila.querySelectorAll("td, th")).map(c => (c.textContent || "").trim().substring(0, 80)),
      };
    });
    console.log("\n=== PRIMERA FILA SAMPLE ===");
    console.log(JSON.stringify(filaSample, null, 2));

    // ── 4. Ejecutar el extractor real y mostrar primeras 3 filas ─────────────
    const extraidos = await extraerParticipantesDelDOM(page);
    console.log(`\n=== EXTRACTOR ACTUAL: ${extraidos.length} filas ===`);
    console.log(JSON.stringify(extraidos.slice(0, 3), null, 2));

    // ── 5. Volcar HTML completo a archivo ────────────────────────────────────
    const html = await page.content();
    const out = path.join(__dirname, "probe-participantes.html");
    fs.writeFileSync(out, html, "utf8");
    console.log(`\n→ HTML completo guardado en: ${out}`);

    if (!headless) {
      console.log("\n[Pausa 30s para inspección visual del navegador. Ctrl+C para salir antes.]");
      await page.waitForTimeout(30_000);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
})();
