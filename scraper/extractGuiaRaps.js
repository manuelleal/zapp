/**
 * scraper/extractGuiaRaps.js
 *
 * PROBE de solo-lectura: navega al árbol de un curso de Zajuna siguiendo la
 * secuencia exacta indicada por el usuario y extrae los códigos de evidencia
 * del formato  GA\d+-\d{9}-AA\d+-EV\d+  desde los <a> links y/o el PDF de la
 * Guía de aprendizaje.
 *
 * Secuencia de clics (fija, sin autonomía):
 *   Curso → FASE 1 ANÁLISIS → Actividad de proyecto 1 → Guía de aprendizaje 01
 *
 * Uso:
 *   node scraper/extractGuiaRaps.js             ← primera ficha activa de la DB
 *   node scraper/extractGuiaRaps.js 9545        ← courseId específico
 *
 * Salidas:
 *   probe-01-curso.png          captura de la página del curso
 *   probe-02-fase.png           captura tras clicar en la Fase
 *   probe-03-actproyecto.png    captura tras clicar en Actividad de proyecto
 *   probe-04-guia.png           captura de la Guía de aprendizaje
 *   guia-descargada.pdf         PDF descargado (si se detectó uno)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs = require("fs");
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

// Regex que captura el código completo de evidencia
const EV_REGEX = /GA\d+-\d{9}-AA\d+-EV\d+/gi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extraerCodigos(texto) {
  return [...new Set((texto.match(EV_REGEX) || []).map(c => c.toUpperCase()))];
}

/**
 * Vuelca todos los links de la página actual para diagnóstico.
 * Retorna el array de { text, href }.
 */
async function dumpLinks(page, etiqueta) {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({ text: (a.textContent || "").replace(/\s+/g, " ").trim(), href: a.href }))
      .filter(l => l.text.length > 1 && !/^javascript/i.test(l.href))
  );
  log(`\n=== ${etiqueta} — ${links.length} links ===`);
  links.forEach(l => log(`  "${l.text.substring(0, 90)}"  →  ${l.href}`));
  return links;
}

/**
 * Intenta descargar un PDF usando las cookies activas del browser y parsearlo
 * con pdf-parse (si está instalado).  Guarda el binario en guia-descargada.pdf
 * sin importar si pdf-parse está disponible o no.
 */
async function intentarParsearPdf(page, pdfUrl) {
  log(`[pdf] Descargando: ${pdfUrl}`);

  // fetch() dentro del contexto del browser para heredar cookies de sesión Moodle
  const descarga = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      const buf = await res.arrayBuffer();
      return { ok: true, bytes: Array.from(new Uint8Array(buf)), size: buf.byteLength };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, pdfUrl);

  if (!descarga.ok) {
    log(`[pdf] Descarga fallida: ${descarga.error}`);
    return [];
  }

  const pdfBuffer = Buffer.from(descarga.bytes);
  fs.writeFileSync("guia-descargada.pdf", pdfBuffer);
  log(`[pdf] Guardado: guia-descargada.pdf  (${descarga.size} bytes)`);

  // Intentar parsear con pdf-parse (opcional — no falla si no está instalado)
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(pdfBuffer);
    log(`[pdf] Texto extraído: ${data.text.length} chars. Muestra:\n${data.text.substring(0, 800)}`);
    const codigos = extraerCodigos(data.text);
    log(`[pdf] Códigos GA en PDF: ${codigos.length > 0 ? codigos.join(", ") : "(ninguno)"}`);
    return codigos;
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      log("[pdf] pdf-parse no instalado.");
      log("[pdf]   → Instala con:  npm install pdf-parse");
      log("[pdf]   → El archivo guia-descargada.pdf ya está guardado para inspección manual.");
    } else {
      log(`[pdf] Error al parsear: ${e.message}`);
    }
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const courseIdArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  // ── Obtener ficha de la DB ──────────────────────────────────────────────────
  const ficha = await prisma.ficha.findFirst({
    where: {
      ...(courseIdArg ? { courseId: courseIdArg } : { courseId: { not: 0 } }),
      archivedAt: null,
    },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true, nombre: true } } },
  });

  if (!ficha) {
    console.log("No hay fichas con courseId en la DB. Escanea fichas primero.");
    await prisma.$disconnect();
    return;
  }

  log(`\nFicha:  ${ficha.codigo}   courseId=${ficha.courseId}   usuario=${ficha.user.nombre}`);

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  // headless:false para debug visual; slowMo da tiempo a ver qué hace
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Capturar PDF que pueda abrirse en pestaña nueva
  let pdfUrlNuevaPestana = null;
  ctx.on("page", async (newPage) => {
    const url = newPage.url();
    log(`[nueva-pestaña] ${url}`);
    if (/pluginfile|\.pdf/i.test(url)) {
      pdfUrlNuevaPestana = url;
      log(`[nueva-pestaña] PDF capturado: ${url}`);
    }
    // Cerrar la pestaña extra para no confundir la navegación principal
    await newPage.close().catch(() => {});
  });

  try {
    await login(page, zajunaUser, zajunaPass);

    // ── PASO 1: Página del curso ───────────────────────────────────────────────
    log("\n══ PASO 1: Página del curso ══");
    await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await cerrarModal(page);
    await page.screenshot({ path: "probe-01-curso.png" });
    const linksCurso = await dumpLinks(page, "CURSO");

    // ── PASO 2: Clic en FASE 1 ANÁLISIS ──────────────────────────────────────
    log("\n══ PASO 2: Buscando FASE 1 ANÁLISIS ══");

    const faseLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a[href]")) {
        const t = (a.textContent || "").trim().toUpperCase();
        // Acepta variaciones: "FASE 1 ANÁLISIS", "FASE I ANÁLISIS", "1. ANÁLISIS", etc.
        if (/(FASE\s*[1I]|AN[AÁ]LISIS)/.test(t)) {
          return { text: a.textContent.trim(), href: a.href };
        }
      }
      return null;
    });

    if (faseLink) {
      log(`  ✓ Fase: "${faseLink.text}"  →  ${faseLink.href}`);
      await page.goto(faseLink.href, { waitUntil: "domcontentloaded" });
      await cerrarModal(page);
    } else {
      log("  ⚠ FASE 1 ANÁLISIS no encontrada como link. Continuando en la página del curso.");
    }

    await page.screenshot({ path: "probe-02-fase.png" });
    await dumpLinks(page, "TRAS FASE");

    // ── PASO 3: Clic en Actividad de proyecto ────────────────────────────────
    log("\n══ PASO 3: Buscando Actividad de proyecto ══");

    const actProyLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a[href]")) {
        const t = (a.textContent || "").trim();
        if (/actividad\s+de\s+proyecto/i.test(t)) {
          return { text: t, href: a.href };
        }
      }
      return null;
    });

    if (actProyLink) {
      log(`  ✓ Act. proyecto: "${actProyLink.text}"  →  ${actProyLink.href}`);
      await page.goto(actProyLink.href, { waitUntil: "domcontentloaded" });
      await cerrarModal(page);
    } else {
      log("  ⚠ 'Actividad de proyecto' no encontrada como link.");
    }

    await page.screenshot({ path: "probe-03-actproyecto.png" });
    await dumpLinks(page, "TRAS ACTIVIDAD DE PROYECTO");

    // ── PASO 4: Clic en Guía de aprendizaje ──────────────────────────────────
    log("\n══ PASO 4: Buscando Guía de aprendizaje ══");

    const guiaLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a[href]")) {
        const t = (a.textContent || "").trim();
        if (/gu[íi]a\s+de\s+aprendizaje/i.test(t)) {
          return { text: t, href: a.href };
        }
      }
      return null;
    });

    if (!guiaLink) {
      log("  ❌ Guía de aprendizaje NO encontrada.");
      log("  Revisa probe-01 a probe-03 para seguir la ruta manualmente.");
      await page.screenshot({ path: "probe-04-sin-guia.png", fullPage: true });
      return;
    }

    log(`  ✓ Guía: "${guiaLink.text}"  →  ${guiaLink.href}`);
    await page.goto(guiaLink.href, { waitUntil: "domcontentloaded" });
    await cerrarModal(page);
    await page.screenshot({ path: "probe-04-guia.png" });

    const urlTrasGuia = page.url();
    log(`  URL tras navegar a la guía: ${urlTrasGuia}`);

    await dumpLinks(page, "PÁGINA DE LA GUÍA");

    // ── PASO 5: Códigos GA en los <a> links de la página ────────────────────
    log("\n══ PASO 5: Extrayendo GA codes de <a> links ══");

    const codigosLinks = await page.evaluate(() => {
      const regex = /GA\d+-\d{9}-AA\d+-EV\d+/gi;
      const resultado = [];
      document.querySelectorAll("a[href]").forEach(link => {
        const text = (link.textContent || "").replace(/\s+/g, " ").trim();
        const href = link.href || "";
        for (const m of (text.match(regex) || [])) {
          resultado.push({ codigo: m.toUpperCase(), texto: text.substring(0, 100), href });
        }
      });
      return resultado;
    });

    if (codigosLinks.length > 0) {
      log(`  ✅ ${codigosLinks.length} código(s) GA en links:`);
      codigosLinks.forEach(c => log(`    ${c.codigo}  |  "${c.texto}"`));
    } else {
      log("  (ningún código GA en <a> links)");
    }

    // ── PASO 6: Códigos GA en todo el texto visible de la página ────────────
    log("\n══ PASO 6: Extrayendo GA codes del body.innerText ══");

    const codigosPagina = await page.evaluate(() => {
      const regex = /GA\d+-\d{9}-AA\d+-EV\d+/gi;
      return [...new Set((document.body.innerText || "").match(regex) || [])].map(c => c.toUpperCase());
    });

    if (codigosPagina.length > 0) {
      log(`  ✅ ${codigosPagina.length} código(s) GA en texto de la página: ${codigosPagina.join(", ")}`);
    } else {
      log("  (ningún código GA en el texto de la página)");
    }

    // ── PASO 7: Detectar URL de PDF y parsearlo ──────────────────────────────
    log("\n══ PASO 7: Buscando y parseando PDF ══");

    // Buscar en la página (iframe embebido, link de descarga, viewer Moodle)
    const pdfEnPagina = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll("a[href], iframe[src], embed[src], object[data]").forEach(el => {
        const url = el.href || el.src || el.data || "";
        if (/pluginfile|forcedownload|\.pdf|mod\/resource\/view/i.test(url) && url.startsWith("http")) {
          urls.add(url);
        }
      });
      return Array.from(urls);
    });

    log(`  PDF links en página: ${pdfEnPagina.length}`);
    pdfEnPagina.forEach(u => log(`    ${u}`));

    const urlDirectaEsPdf = /pluginfile.*\.pdf|\?forcedownload=1/i.test(urlTrasGuia);
    if (urlDirectaEsPdf) {
      log(`  URL actual parece ser PDF directo: ${urlTrasGuia}`);
    }

    // Elegir la mejor URL de PDF para parsear
    const pdfTarget =
      pdfEnPagina[0] ||
      (pdfUrlNuevaPestana) ||
      (urlDirectaEsPdf ? urlTrasGuia : null);

    let codigosPdf = [];
    if (pdfTarget) {
      codigosPdf = await intentarParsearPdf(page, pdfTarget);
    } else {
      log("  No se detectó ningún PDF en esta página.");
      log("  → Revisa probe-04-guia.png. Si el PDF abre en otra pestaña fuera del control del script,");
      log("    copia su URL y pasa:  node scraper/extractGuiaRaps.js <courseId>  después de inspeccionar.");
    }

    // ── RESUMEN ───────────────────────────────────────────────────────────────
    const todos = [...new Set([
      ...codigosLinks.map(c => c.codigo),
      ...codigosPagina,
      ...codigosPdf,
    ])];

    log("\n╔═══════════════════════════════════════════╗");
    log(`║  RESUMEN — ficha ${ficha.codigo}  courseId=${ficha.courseId}`);
    log("╠═══════════════════════════════════════════╣");
    log(`║  Guía URL  : ${guiaLink.href}`);
    log(`║  Códigos únicos encontrados: ${todos.length}`);
    if (todos.length > 0) {
      todos.forEach(c => {
        const parts = c.split("-");
        // GA1 - 220501092 - AA1 - EV01
        const ga          = parts[0] || "?";
        const competencia = parts[1] || "?";
        const aa          = parts[2] || "?";
        const ev          = parts[3] || "?";
        log(`║    ${c}`);
        log(`║      competencia=${competencia}  guia=${ga}  actividad=${aa}  evidencia=${ev}`);
      });
    } else {
      log("║  ⚠ Ningún código extraído.");
      log("║  Próximos pasos:");
      log("║  1. Abre probe-04-guia.png para ver qué hay en la página de la guía.");
      log("║  2. Si la guía está en un iframe, puede requerir navegar al iframe src.");
      log("║  3. Si el PDF se descargó, ábrelo: guia-descargada.pdf");
      log("║  4. Instala pdf-parse si falta:  npm install pdf-parse");
    }
    log("╚═══════════════════════════════════════════╝");

    await page.waitForTimeout(4000); // tiempo para revisar visualmente el navegador
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1) });
