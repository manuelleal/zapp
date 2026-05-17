/**
 * scraper/probeH2GuiasIterator.js
 *
 * HIPÓTESIS 2 — Scraper dinámico multi-guía.
 *
 * Navega al árbol del curso y encuentra TODAS las Guías de aprendizaje
 * sin hardcodear el número de guía ni el nombre de la fase.
 *
 * Estrategia:
 *   1. Carga la página del curso.
 *   2. Busca links con texto /guía de aprendizaje/i  (detecta GA01 a GA09+).
 *   3. Por cada guía: sigue el link, toma screenshot, extrae:
 *      - Códigos GA<n>-<9dig>-AA<n>-EV<n> del texto visible y de los <a> links.
 *      - URLs de PDF (pluginfile / forcedownload / mod/resource/view).
 *   4. Guarda probe-h2-guia01.png … probe-h2-guia09.png.
 *   5. Genera probe-h2-resultado.json con toda la información.
 *
 * También intenta la API REST de Moodle:
 *   core_course_get_contents  →  árbol completo del curso en JSON.
 *
 * Uso:
 *   node scraper/probeH2GuiasIterator.js             ← primera ficha activa
 *   node scraper/probeH2GuiasIterator.js 9545        ← courseId específico
 *
 * Salidas:
 *   probe-h2-guia01.png … probe-h2-guiaN.png
 *   probe-h2-resultado.json
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

const EV_REGEX   = /GA(\d+)-(\d{9})-AA(\d+)-EV(\d+)/gi;
// Detecta "Guía de aprendizaje 01", "Guia aprendizaje 3", "GUÍA 02", etc.
const GUIA_REGEX = /gu[íi]a(\s+de)?\s+aprendizaje\s*0*(\d+)/i;

function extraerCodigos(texto) {
  const vistos = new Set();
  const hits = [];
  for (const m of (texto.matchAll ? texto.matchAll(EV_REGEX) : [])) {
    const codigo = m[0].toUpperCase();
    if (!vistos.has(codigo)) {
      vistos.add(codigo);
      hits.push({
        codigo,
        guiaNum:          parseInt(m[1], 10),
        competenciaCodigo: m[2],
        aaNum:            parseInt(m[3], 10),
        evNum:            parseInt(m[4], 10),
      });
    }
  }
  return hits;
}

async function llamarApiCurso(page, courseId) {
  log(`[api] core_course_get_contents courseId=${courseId}`);

  const result = await page.evaluate(async ({ baseUrl, courseId }) => {
    const sesskey =
      window.M?.cfg?.sesskey ||
      document.querySelector('input[name="sesskey"]')?.value ||
      new URL(
        document.querySelector('a[data-title="logout,moodle"]')?.href || "http://x"
      ).searchParams.get("sesskey");

    if (!sesskey) return { ok: false, error: "No sesskey" };

    const url = `${baseUrl}/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_contents`;
    try {
      const res = await fetch(url, {
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

async function extraerGuiaLinks(page) {
  return page.evaluate((guiaPattern) => {
    const re = new RegExp(guiaPattern, "i");
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const texto = (a.textContent || "").replace(/\s+/g, " ").trim();
      const m = texto.match(re);
      if (m) {
        links.push({
          texto,
          href:    a.href,
          guiaNum: parseInt(m[2] || "1", 10),
        });
      }
    }
    // Desduplicar por href
    const seen = new Set();
    return links.filter(l => {
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    }).sort((a, b) => a.guiaNum - b.guiaNum);
  }, GUIA_REGEX.source);
}

async function extraerPdfLinks(page) {
  return page.evaluate(() => {
    const urls = new Set();
    document.querySelectorAll("a[href], iframe[src], embed[src], object[data]").forEach(el => {
      const url = el.href || el.src || el.data || "";
      if (/pluginfile|forcedownload|\.pdf|mod\/resource\/view/i.test(url) && url.startsWith("http")) {
        urls.add(url);
      }
    });
    return Array.from(urls);
  });
}

async function procesarGuia(page, guiaLink, idx) {
  const { texto, href, guiaNum } = guiaLink;
  const pad = String(idx + 1).padStart(2, "0");

  log(`\n  ── Guía ${pad}: "${texto}"  →  ${href}`);
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await cerrarModal(page);
  await page.screenshot({ path: `probe-h2-guia${pad}.png` });

  const urlTras = page.url();

  // Códigos en links <a>
  const codigosLinks = await page.evaluate(() => {
    const regex = /GA\d+-\d{9}-AA\d+-EV\d+/gi;
    const result = [];
    document.querySelectorAll("a[href]").forEach(a => {
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      for (const m of (text.match(regex) || [])) {
        result.push({ codigo: m.toUpperCase(), texto: text.substring(0, 100), href: a.href });
      }
    });
    return result;
  });

  // Códigos en body.innerText
  const textoCodigos = extraerCodigos(
    await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "))
  );

  // URLs de PDF
  const pdfUrls = await extraerPdfLinks(page);

  // Sub-links de esta página (para diagnóstico)
  const subLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({
        texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80),
        href:  a.href,
      }))
      .filter(l => l.texto.length > 1 && !/^javascript/i.test(l.href))
  );

  const todos = [
    ...new Set([
      ...codigosLinks.map(c => c.codigo),
      ...textoCodigos.map(c => c.codigo),
    ]),
  ];

  log(`     Códigos GA encontrados : ${todos.length > 0 ? todos.join(", ") : "(ninguno)"}`);
  log(`     PDF URLs encontradas   : ${pdfUrls.length}`);
  pdfUrls.forEach(u => log(`       ${u}`));

  return {
    guiaNum,
    guiaTexto:   texto,
    guiaHref:    href,
    urlFinal:    urlTras,
    screenshot:  `probe-h2-guia${pad}.png`,
    codigosLinks,
    codigosTexto: textoCodigos,
    pdfUrls,
    subLinks,
  };
}

async function main() {
  const courseIdArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;

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

  log(`\nFicha: ${ficha.codigo}  courseId=${ficha.courseId}  usuario=${ficha.user.nombre}`);

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Capturar PDFs que abran en pestaña nueva
  const pdfsPestanaNueva = [];
  ctx.on("page", async (newPage) => {
    const url = newPage.url();
    if (/pluginfile|\.pdf/i.test(url)) {
      pdfsPestanaNueva.push(url);
      log(`[nueva-pestaña] PDF: ${url}`);
    }
    await newPage.close().catch(() => {});
  });

  const resultado = {
    ficha:    ficha.codigo,
    courseId: ficha.courseId,
    guias:    [],
    apiCurso: null,
  };

  try {
    await login(page, zajunaUser, zajunaPass);

    // ── Intento API REST ─────────────────────────────────────────────────────
    log("\n══ API core_course_get_contents ══");
    await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
      waitUntil: "domcontentloaded",
      timeout:   TIMEOUT,
    });
    await cerrarModal(page);

    const apiResult = await llamarApiCurso(page, ficha.courseId);
    resultado.apiCurso = apiResult;

    if (apiResult.ok && Array.isArray(apiResult.data?.[0]?.data)) {
      log("  ✅ API devolvió árbol del curso.");
      // Buscar módulos con nombre de guía dentro del árbol
      const secciones = apiResult.data[0].data;
      log(`  Secciones: ${secciones.length}`);
      for (const sec of secciones) {
        log(`    Sección: "${sec.name}"`);
        for (const mod of (sec.modules || [])) {
          if (GUIA_REGEX.test(mod.name || "")) {
            log(`      → Guía vía API: "${mod.name}"  url=${mod.url || mod.modplural}`);
          }
        }
      }
    } else {
      log(`  ⚠  API: ${apiResult.error || "vacía"}`);
    }

    // ── Escaneo DOM: encontrar todos los links de guías ──────────────────────
    log("\n══ Buscando links de Guías de aprendizaje en DOM ══");
    await page.screenshot({ path: "probe-h2-curso.png" });

    const guiaLinks = await extraerGuiaLinks(page);
    log(`  Links de guías encontrados: ${guiaLinks.length}`);

    if (guiaLinks.length === 0) {
      log("  ⚠  No se encontraron guías directamente en la página del curso.");
      log("  Intentando navegar a FASE 1 ANÁLISIS primero...");

      const faseLink = await page.evaluate(() => {
        for (const a of document.querySelectorAll("a[href]")) {
          const t = (a.textContent || "").trim().toUpperCase();
          if (/(FASE\s*[1I]|AN[AÁ]LISIS)/.test(t)) return { text: a.textContent.trim(), href: a.href };
        }
        return null;
      });

      if (faseLink) {
        log(`  ✓ Fase: "${faseLink.text}" → ${faseLink.href}`);
        await page.goto(faseLink.href, { waitUntil: "domcontentloaded" });
        await cerrarModal(page);
        const guiaLinksEnFase = await extraerGuiaLinks(page);
        log(`  Links de guías en Fase: ${guiaLinksEnFase.length}`);
        guiaLinks.push(...guiaLinksEnFase);
      }

      if (guiaLinks.length === 0) {
        log("  ⚠  Intentando Actividad de proyecto...");
        const actLink = await page.evaluate(() => {
          for (const a of document.querySelectorAll("a[href]")) {
            if (/actividad\s+de\s+proyecto/i.test(a.textContent || "")) return { href: a.href };
          }
          return null;
        });
        if (actLink) {
          await page.goto(actLink.href, { waitUntil: "domcontentloaded" });
          await cerrarModal(page);
          const guiaLinksEnAct = await extraerGuiaLinks(page);
          guiaLinks.push(...guiaLinksEnAct);
          log(`  Links de guías en Actividad de proyecto: ${guiaLinksEnAct.length}`);
        }
      }
    }

    // ── Procesar cada guía ───────────────────────────────────────────────────
    log(`\n══ Procesando ${guiaLinks.length} guía(s) ══`);

    for (let i = 0; i < guiaLinks.length; i++) {
      const datosGuia = await procesarGuia(page, guiaLinks[i], i);
      // Adjuntar PDFs de pestaña nueva si los hay y esta guía no los tenía
      if (pdfsPestanaNueva.length > 0 && datosGuia.pdfUrls.length === 0) {
        datosGuia.pdfUrls = [...pdfsPestanaNueva];
        pdfsPestanaNueva.length = 0;
      }
      resultado.guias.push(datosGuia);
      // Volver al curso para buscar la siguiente guía si no estamos en la misma página
      if (i < guiaLinks.length - 1) {
        await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
          waitUntil: "domcontentloaded",
        });
        await cerrarModal(page);
      }
    }

    // ── Guardar resultado ────────────────────────────────────────────────────
    const outPath = "probe-h2-resultado.json";
    fs.writeFileSync(outPath, JSON.stringify(resultado, null, 2));
    log(`\n✅ Resultado guardado en ${outPath}`);

    // ── Resumen ──────────────────────────────────────────────────────────────
    log("\n╔══════════════════════════════════════════╗");
    log(`║  RESUMEN H2 — ficha ${ficha.codigo}`);
    log("╠══════════════════════════════════════════╣");
    log(`║  Guías procesadas: ${resultado.guias.length}`);

    const todosCodigos = new Set();
    for (const g of resultado.guias) {
      [...g.codigosLinks, ...g.codigosTexto].forEach(c => todosCodigos.add(c.codigo || c));
      log(`║  Guía ${String(g.guiaNum).padStart(2, "0")}: ${todosCodigos.size > 0 ? [...todosCodigos].slice(-5).join(", ") : "(sin códigos)"}`);
      log(`║    PDFs: ${g.pdfUrls.length}`);
    }

    log(`║  Total códigos GA únicos: ${todosCodigos.size}`);
    if (todosCodigos.size === 0) {
      log("║  ⚠  No se encontraron códigos GA.");
      log("║  → Ejecuta probeH3PdfBatch.js para parsear los PDFs.");
    } else {
      log("║  ✅ Códigos encontrados en DOM. probeH3 para enriquecer con descripciones.");
    }
    log("╚══════════════════════════════════════════╝\n");

    await page.waitForTimeout(3000);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
