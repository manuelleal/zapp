/**
 * scraper/probeH2GuiasIterator.js — Hipótesis 2: Iterador de Guías de Aprendizaje
 *
 * MISIÓN: Navegar el árbol del curso en Zajuna y recolectar las URLs de PDF de
 * cada Guía de Aprendizaje (GA01–GA09+), sin hardcodear números ni rutas.
 *
 * ESTRATEGIA en cascada (pasa al siguiente si el anterior falla):
 *   1. API REST  core_course_get_contents  → árbol completo del curso en JSON
 *   2. DOM scraping en la página del curso (secciones expandidas)
 *   3. Navegación por FASE ANÁLISIS → Actividad de proyecto → Guías
 *
 * SALIDAS:
 *   probe-h2-curso.png          captura de la página del curso
 *   probe-h2-guia01.png …       captura de cada guía visitada
 *   probe-h2-resultado.json     { ficha, courseId, guias: [{guiaNum, href, pdfUrls, …}] }
 *
 * Uso:
 *   node scraper/probeH2GuiasIterator.js             ← primera ficha activa
 *   node scraper/probeH2GuiasIterator.js 9545        ← courseId específico
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs   = require("fs");
const path = require("path");
const { chromium }                          = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt }                           = require("../api/src/lib/crypto");
const prisma                                = require("../api/src/db/client");

// ── Regex de detección ────────────────────────────────────────────────────────

/** Detecta cualquier variación de "Guía de aprendizaje 01/1/02/…" en texto de link */
const GUIA_REGEX = /gu[íi]a(\s+de)?\s+aprendizaje\s*0*(\d+)/i;

/** Código de evidencia completo — para confirmación visual */
const EV_REGEX = /GA(\d+)-(\d{9})-AA(\d+)-EV(\d+)/gi;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extrae todos los links <a> de la página junto con su texto.
 * Útil para diagnóstico cuando no encontramos lo que buscamos.
 */
async function dumpLinks(page, etiqueta) {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({
        texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 100),
        href:  a.href,
      }))
      .filter(l => l.texto.length > 1 && !/^javascript/i.test(l.href))
  );
  log(`\n  [links] ${etiqueta} — ${links.length} links`);
  links.forEach(l => log(`    "${l.texto}"  →  ${l.href.substring(0, 100)}`));
  return links;
}

/**
 * Busca en el DOM todos los links cuyo texto coincida con el regex de guía.
 * Devuelve array ordenado por número de guía, sin duplicados de href.
 */
async function buscarGuiaLinksEnDOM(page) {
  return page.evaluate((pattern) => {
    const re  = new RegExp(pattern, "i");
    const map = new Map(); // href → {texto, guiaNum}
    for (const a of document.querySelectorAll("a[href]")) {
      const texto = (a.textContent || "").replace(/\s+/g, " ").trim();
      const m     = texto.match(re);
      if (m && !map.has(a.href)) {
        map.set(a.href, { texto, href: a.href, guiaNum: parseInt(m[2] || "1", 10) });
      }
    }
    return [...map.values()].sort((a, b) => a.guiaNum - b.guiaNum);
  }, GUIA_REGEX.source);
}

/**
 * Extrae URLs de PDF que estén presentes en la página actual.
 * Busca en <a href>, <iframe src>, <embed src>, <object data>.
 */
async function extraerPdfLinks(page) {
  const urls = await page.evaluate(() => {
    const found = new Set();
    document.querySelectorAll("a[href], iframe[src], embed[src], object[data]").forEach(el => {
      const url = el.href || el.src || el.data || "";
      // pluginfile = archivo de Moodle; forcedownload = descarga directa; .pdf = extensión
      if (/pluginfile|forcedownload|\.pdf/i.test(url) && url.startsWith("http")) {
        found.add(url);
      }
    });
    return [...found];
  });
  log(`  [pdf-links] ${urls.length} URL(s) de PDF en la página`);
  urls.forEach(u => log(`    ${u.substring(0, 110)}`));
  return urls;
}

/**
 * Intenta el endpoint REST core_course_get_contents para obtener el árbol
 * completo del curso en formato JSON, sin necesidad de navegar el DOM.
 * Requiere que ya estemos logueados y en cualquier página de Zajuna.
 */
async function apiGetCourseContents(page, courseId) {
  log(`\n  [api] Llamando core_course_get_contents para courseId=${courseId}...`);

  const result = await page.evaluate(async ({ baseUrl, courseId }) => {
    // Buscar la sesskey de Moodle en varios lugares posibles
    const sesskey =
      window.M?.cfg?.sesskey ||
      document.querySelector('input[name="sesskey"]')?.value ||
      new URL(
        document.querySelector('a[data-title="logout,moodle"]')?.href || "http://x"
      ).searchParams.get("sesskey") ||
      null;

    if (!sesskey) return { ok: false, error: "No sesskey encontrado" };

    const url = `${baseUrl}/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_contents`;
    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify([{
          index:      0,
          methodname: "core_course_get_contents",
          args:       { courseid: Number(courseId) },
        }]),
      });
      const json = await res.json();
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, { baseUrl: BASE_URL, courseId });

  return result;
}

/**
 * Dado el resultado de core_course_get_contents, extrae módulos cuyo nombre
 * coincida con el patrón de Guía de aprendizaje.
 * Devuelve array de { guiaNum, nombre, url }.
 */
function extraerGuiasDeApiTree(apiData) {
  const guias = [];
  try {
    const secciones = apiData?.data?.[0]?.data;
    if (!Array.isArray(secciones)) return guias;
    for (const sec of secciones) {
      log(`  [api-tree] Sección: "${sec.name}" (${sec.modules?.length ?? 0} módulos)`);
      for (const mod of (sec.modules || [])) {
        const m = (mod.name || "").match(GUIA_REGEX);
        if (m) {
          const guiaNum = parseInt(m[2] || "1", 10);
          const url     = mod.url || mod.modplural || "";
          log(`    → Guía ${guiaNum}: "${mod.name}"  url=${url.substring(0, 80)}`);
          guias.push({ guiaNum, nombre: mod.name, url });
        }
      }
    }
  } catch (e) {
    log(`  [api-tree] Error parseando árbol: ${e.message}`);
  }
  return guias.sort((a, b) => a.guiaNum - b.guiaNum);
}

/**
 * Visita una URL de guía, toma screenshot, extrae códigos GA del DOM y
 * recolecta URLs de PDF encontradas en la página.
 */
async function procesarPaginaGuia(page, href, guiaNum, screenshotPath) {
  log(`\n  [guia${guiaNum}] Navegando a: ${href.substring(0, 100)}`);
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await cerrarModal(page);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log(`  [guia${guiaNum}] Screenshot: ${screenshotPath}`);

  const urlFinal = page.url();
  log(`  [guia${guiaNum}] URL final: ${urlFinal.substring(0, 100)}`);

  // ── Códigos GA en el texto visible ────────────────────────────────────────
  const codigosEnPagina = await page.evaluate(() => {
    const regex  = /GA\d+-\d{9}-AA\d+-EV\d+/gi;
    const vistos = new Set();
    const hits   = [];
    // 1. Texto del body completo
    for (const m of ((document.body.innerText || "").match(regex) || [])) {
      const c = m.toUpperCase();
      if (!vistos.has(c)) { vistos.add(c); hits.push({ fuente: "innerText", codigo: c }); }
    }
    // 2. Texto de cada link <a>
    document.querySelectorAll("a[href]").forEach(a => {
      for (const m of ((a.textContent || "").match(regex) || [])) {
        const c = m.toUpperCase();
        if (!vistos.has(c)) { vistos.add(c); hits.push({ fuente: "link", codigo: c, href: a.href }); }
      }
    });
    return hits;
  });

  log(`  [guia${guiaNum}] Códigos GA en página: ${codigosEnPagina.length > 0 ? codigosEnPagina.map(c=>c.codigo).join(", ") : "(ninguno)"}`);

  // ── PDF links en la página ─────────────────────────────────────────────────
  const pdfUrls = await extraerPdfLinks(page);

  // ── Sub-links (para diagnóstico) ───────────────────────────────────────────
  const subLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({
        texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80),
        href:  a.href.substring(0, 120),
      }))
      .filter(l => l.texto.length > 1 && !/^javascript/i.test(l.href))
  );

  return { guiaNum, href, urlFinal, screenshotPath, codigosEnPagina, pdfUrls, subLinks };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const courseIdArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  // ── 1. Obtener ficha de la DB ──────────────────────────────────────────────
  const ficha = await prisma.ficha.findFirst({
    where: {
      ...(courseIdArg ? { courseId: courseIdArg } : { courseId: { not: 0 } }),
      archivedAt: null,
    },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true, nombre: true } } },
  });

  if (!ficha) {
    console.log("No hay fichas con courseId. Escanea fichas primero.");
    await prisma.$disconnect();
    return;
  }

  log(`\nFicha: ${ficha.codigo}  courseId=${ficha.courseId}  usuario=${ficha.user.nombre}`);

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  // headless:false para ver la navegación en vivo
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Captura PDFs que abren en pestaña nueva
  const pdfsPestanaNueva = [];
  ctx.on("page", async (newPage) => {
    const url = newPage.url();
    log(`[nueva-pestaña] ${url.substring(0, 100)}`);
    if (/pluginfile|\.pdf/i.test(url)) {
      pdfsPestanaNueva.push(url);
      log(`[nueva-pestaña] PDF capturado: ${url.substring(0, 100)}`);
    }
    await newPage.close().catch(() => {});
  });

  const resultado = {
    ficha:    ficha.codigo,
    courseId: ficha.courseId,
    guias:    [],
    apiTree:  null,
  };

  try {
    // ── 2. Login ────────────────────────────────────────────────────────────
    await login(page, zajunaUser, zajunaPass);

    // ── 3. Cargar página del curso ───────────────────────────────────────────
    log(`\n══ PASO 1: Página del curso ${ficha.courseId} ══`);
    await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
      waitUntil: "domcontentloaded",
      timeout:   TIMEOUT,
    });
    await cerrarModal(page);
    await page.screenshot({ path: "probe-h2-curso.png" });
    log("  Screenshot: probe-h2-curso.png");

    // ── 4. Intentar API REST primero ─────────────────────────────────────────
    log("\n══ PASO 2: API core_course_get_contents ══");
    const apiResult = await apiGetCourseContents(page, ficha.courseId);
    resultado.apiTree = { ok: apiResult.ok, error: apiResult.error ?? null };

    let guiaLinksDesdeApi = [];
    if (apiResult.ok) {
      log("  ✅ API respondió — analizando árbol...");
      guiaLinksDesdeApi = extraerGuiasDeApiTree(apiResult);
      log(`  Guías vía API: ${guiaLinksDesdeApi.length}`);
    } else {
      log(`  ⚠  API falló: ${apiResult.error}`);
    }

    // ── 5. DOM scraping como respaldo o complemento ──────────────────────────
    log("\n══ PASO 3: Buscar guías en DOM ══");
    let guiaLinksDOM = await buscarGuiaLinksEnDOM(page);
    log(`  Guías directamente en DOM del curso: ${guiaLinksDOM.length}`);

    if (guiaLinksDOM.length === 0) {
      log("  → Intentando FASE ANÁLISIS...");
      const faseLink = await page.evaluate(() => {
        for (const a of document.querySelectorAll("a[href]")) {
          if (/(FASE\s*[1I]|AN[AÁ]LISIS)/i.test(a.textContent || "")) {
            return { texto: a.textContent.trim(), href: a.href };
          }
        }
        return null;
      });

      if (faseLink) {
        log(`  Fase encontrada: "${faseLink.texto}" → ${faseLink.href.substring(0, 80)}`);
        await page.goto(faseLink.href, { waitUntil: "domcontentloaded" });
        await cerrarModal(page);
        guiaLinksDOM = await buscarGuiaLinksEnDOM(page);
        log(`  Guías tras navegar a Fase: ${guiaLinksDOM.length}`);
      }

      if (guiaLinksDOM.length === 0) {
        log("  → Intentando Actividad de proyecto...");
        const actLink = await page.evaluate(() => {
          for (const a of document.querySelectorAll("a[href]")) {
            if (/actividad\s+de\s+proyecto/i.test(a.textContent || "")) return { href: a.href };
          }
          return null;
        });
        if (actLink) {
          await page.goto(actLink.href, { waitUntil: "domcontentloaded" });
          await cerrarModal(page);
          guiaLinksDOM = await buscarGuiaLinksEnDOM(page);
          log(`  Guías tras Actividad de proyecto: ${guiaLinksDOM.length}`);
        }
      }

      if (guiaLinksDOM.length === 0) {
        // Volcado completo de links para diagnóstico
        await dumpLinks(page, "TODOS LOS LINKS DE LA PÁGINA");
      }
    }

    // Combinar fuentes sin duplicar por guiaNum
    const guiasMap = new Map();
    for (const g of guiaLinksDOM) {
      guiasMap.set(g.guiaNum, { texto: g.texto, href: g.href, guiaNum: g.guiaNum });
    }
    // Los links de API complementan si tienen URL real
    for (const g of guiaLinksDesdeApi) {
      if (g.url && !guiasMap.has(g.guiaNum)) {
        guiasMap.set(g.guiaNum, { texto: g.nombre, href: g.url, guiaNum: g.guiaNum });
      }
    }
    const guiasFinales = [...guiasMap.values()].sort((a, b) => a.guiaNum - b.guiaNum);
    log(`\n  Total guías a procesar: ${guiasFinales.length}`);

    if (guiasFinales.length === 0) {
      log("  ❌ No se encontraron guías. Revisa probe-h2-curso.png.");
      await page.waitForTimeout(5000);
      return;
    }

    // ── 6. Procesar cada guía ────────────────────────────────────────────────
    log("\n══ PASO 4: Procesar cada guía ══");

    for (let i = 0; i < guiasFinales.length; i++) {
      const g          = guiasFinales[i];
      const pad        = String(g.guiaNum).padStart(2, "0");
      const screenshot = `probe-h2-guia${pad}.png`;

      log(`\n  ─── Guía ${pad} (${i + 1}/${guiasFinales.length}) ─────────────────────`);

      const datos = await procesarPaginaGuia(page, g.href, g.guiaNum, screenshot);

      // Adjuntar PDFs que abrieron en pestaña nueva
      if (pdfsPestanaNueva.length > 0 && datos.pdfUrls.length === 0) {
        log(`  [guia${pad}] Adjuntando ${pdfsPestanaNueva.length} PDF(s) de pestaña nueva`);
        datos.pdfUrls = [...pdfsPestanaNueva];
        pdfsPestanaNueva.length = 0;
      }

      resultado.guias.push(datos);

      // Si hay que navegar a la siguiente, volver al curso
      if (i < guiasFinales.length - 1) {
        await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
          waitUntil: "domcontentloaded",
        });
        await cerrarModal(page);
      }
    }

    // ── 7. Guardar resultado ─────────────────────────────────────────────────
    const outPath = "probe-h2-resultado.json";
    fs.writeFileSync(outPath, JSON.stringify(resultado, null, 2));
    log(`\n✅ Resultado guardado: ${outPath}`);

    // ── 8. Resumen ───────────────────────────────────────────────────────────
    log("\n╔═══════════════════════════════════════════╗");
    log(`║  RESUMEN H2 — ficha ${ficha.codigo}`);
    log("╠═══════════════════════════════════════════╣");
    log(`║  Guías procesadas : ${resultado.guias.length}`);
    for (const g of resultado.guias) {
      const codCount = g.codigosEnPagina?.length ?? 0;
      const pdfCount = g.pdfUrls?.length ?? 0;
      log(`║  GA${String(g.guiaNum).padStart(2,"0")}: ${codCount} código(s) GA, ${pdfCount} PDF(s)`);
    }
    const totalPdfs = resultado.guias.reduce((s, g) => s + (g.pdfUrls?.length ?? 0), 0);
    log("╠═══════════════════════════════════════════╣");
    log(`║  Total PDFs encontrados: ${totalPdfs}`);
    if (totalPdfs === 0) {
      log("║  ⚠  No se encontraron PDFs.");
      log("║  → Revisa los screenshots probe-h2-guia*.png");
    } else {
      log("║  ✅ Listo para procesar con probeH3PdfBatch.js");
    }
    log("╚═══════════════════════════════════════════╝\n");

    await page.waitForTimeout(4000);

  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
