/**
 * scraper/probeH3PdfBatch.js
 *
 * HIPÓTESIS 3 — Descarga y parseo de PDFs en batch.
 *
 * Lee probe-h2-resultado.json (generado por probeH2GuiasIterator.js),
 * descarga cada PDF usando las cookies activas del browser (sesión Moodle),
 * parsea el texto con pdf-parse y extrae:
 *   - Códigos GA<n>-<9dig>-AA<n>-EV<n>
 *   - Descripciones de RAP con patrón:
 *       /(RAP|Resultado\s+de\s+Aprendizaje)\s*(\d+)[:\-\.\s]\s*([^\n]{20,400})/gi
 *
 * Genera probe-h3-resultado.json con:
 *   {
 *     guiaNum, pdfUrl,
 *     codigosGA: [{ codigo, guiaNum, competenciaCodigo, aaNum, evNum }],
 *     raps:      [{ rapNum, descripcion }],
 *     textoMuestra: "<primeros 600 chars>"
 *   }
 *
 * Uso:
 *   node scraper/probeH3PdfBatch.js                     ← lee probe-h2-resultado.json
 *   node scraper/probeH3PdfBatch.js <path-a-resultado>  ← archivo custom
 *
 * Si pdf-parse no está instalado:
 *   npm install pdf-parse        (en la raíz del proyecto)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs    = require("fs");
const path  = require("path");
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

const EV_REGEX  = /GA(\d+)-(\d{9})-AA(\d+)-EV(\d+)/gi;
// Captura "RAP 1: descripción..." o "Resultado de Aprendizaje 2 - ..."
const RAP_REGEX = /(RAP|Resultado\s+de\s+Aprendizaje)\s*(\d+)\s*[:\-\.]\s*([^\n]{20,400})/gi;

function parsearCodigosGA(texto) {
  const vistos = new Set();
  const hits = [];
  for (const m of texto.matchAll(EV_REGEX)) {
    const codigo = m[0].toUpperCase();
    if (!vistos.has(codigo)) {
      vistos.add(codigo);
      hits.push({
        codigo,
        guiaNum:           parseInt(m[1], 10),
        competenciaCodigo:  m[2],
        aaNum:             parseInt(m[3], 10),
        evNum:             parseInt(m[4], 10),
      });
    }
  }
  return hits;
}

function parsearRaps(texto) {
  const vistos = new Set();
  const raps = [];
  for (const m of texto.matchAll(RAP_REGEX)) {
    const rapNum = parseInt(m[2], 10);
    if (!vistos.has(rapNum)) {
      vistos.add(rapNum);
      raps.push({
        rapNum,
        descripcion: m[3].replace(/\s+/g, " ").trim(),
      });
    }
  }
  return raps.sort((a, b) => a.rapNum - b.rapNum);
}

async function descargarPdf(page, pdfUrl) {
  log(`  [pdf] Descargando: ${pdfUrl.substring(0, 100)}…`);

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
    log(`  [pdf] ❌ Error: ${descarga.error}`);
    return null;
  }

  log(`  [pdf] ✓ ${descarga.size} bytes`);
  return Buffer.from(descarga.bytes);
}

async function parsearPdf(buffer, guiaNum) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (e) {
    log("  [pdf-parse] No instalado. Instala con: npm install pdf-parse");
    return { texto: null, codigosGA: [], raps: [] };
  }

  try {
    const data = await pdfParse(buffer);
    const texto = data.text || "";
    log(`  [pdf-parse] Guía ${guiaNum}: ${texto.length} chars`);

    const codigosGA = parsearCodigosGA(texto);
    const raps      = parsearRaps(texto);

    log(`    Códigos GA: ${codigosGA.length > 0 ? codigosGA.map(c => c.codigo).join(", ") : "(ninguno)"}`);
    log(`    RAPs       : ${raps.length > 0 ? raps.map(r => `RAP${r.rapNum}`).join(", ") : "(ninguno)"}`);
    if (raps.length > 0) {
      raps.forEach(r => log(`      RAP${r.rapNum}: ${r.descripcion.substring(0, 100)}`));
    }

    return { texto, codigosGA, raps };
  } catch (e) {
    log(`  [pdf-parse] Error: ${e.message}`);
    return { texto: null, codigosGA: [], raps: [] };
  }
}

async function main() {
  const h2File = process.argv[2] || "probe-h2-resultado.json";

  if (!fs.existsSync(h2File)) {
    console.error(`\n❌ Archivo no encontrado: ${h2File}`);
    console.error("  → Ejecuta primero: node scraper/probeH2GuiasIterator.js");
    process.exit(1);
  }

  const h2 = JSON.parse(fs.readFileSync(h2File, "utf-8"));
  log(`\n[H3] Leyendo ${h2File}  —  ${h2.guias?.length ?? 0} guías`);

  // Recopilar todas las URLs de PDF únicas con su guía
  const tareasDescarga = [];
  for (const guia of (h2.guias || [])) {
    for (const pdfUrl of (guia.pdfUrls || [])) {
      tareasDescarga.push({ guiaNum: guia.guiaNum, pdfUrl });
    }
  }

  if (tareasDescarga.length === 0) {
    console.log("\n⚠  No hay URLs de PDF en probe-h2-resultado.json.");
    console.log("  → Revisa los screenshots probe-h2-guia*.png para ver si los PDFs se abrieron en browser.");
    console.log("  → Puede que los PDFs estén en iframes o requieran navegación directa al resource viewer.");
    console.log("  → Ejecuta probeH2GuiasIterator.js con el browser visible y copia las URLs manualmente.");
    process.exit(0);
  }

  log(`\nPDFs a procesar: ${tareasDescarga.length}`);
  tareasDescarga.forEach((t, i) => log(`  ${i + 1}. Guía ${t.guiaNum}: ${t.pdfUrl.substring(0, 80)}…`));

  // Necesitamos sesión Moodle para descargar con cookies
  const ficha = await prisma.ficha.findFirst({
    where:   { courseId: h2.courseId ? Number(h2.courseId) : { not: 0 }, archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true, nombre: true } } },
  });

  if (!ficha) {
    console.log("No hay ficha en DB para courseId del resultado H2. Abortando.");
    await prisma.$disconnect();
    return;
  }

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  const resultados = [];

  try {
    await login(page, zajunaUser, zajunaPass);

    // Warm up: abrir el curso una vez para asegurar sesión completa
    await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, {
      waitUntil: "domcontentloaded",
    });
    await cerrarModal(page);

    for (const tarea of tareasDescarga) {
      log(`\n══ Procesando Guía ${tarea.guiaNum} PDF ══`);

      // Si la URL es mod/resource/view (visor Moodle), navegar primero para
      // que Moodle redirija al pluginfile real
      let urlPdf = tarea.pdfUrl;
      if (/mod\/resource\/view/i.test(urlPdf)) {
        log("  URL es visor Moodle, navegando para obtener URL real del PDF...");
        await page.goto(urlPdf, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await cerrarModal(page);
        // Buscar el PDF real en la página del visor
        const pdfReal = await page.evaluate(() => {
          for (const el of document.querySelectorAll("a[href], iframe[src], embed[src], object[data]")) {
            const url = el.href || el.src || el.data || "";
            if (/pluginfile.*\.pdf|forcedownload/i.test(url)) return url;
          }
          // También intentar el link de "Clic aquí" estándar de Moodle
          for (const a of document.querySelectorAll("a[href]")) {
            if (/pluginfile/i.test(a.href)) return a.href;
          }
          return null;
        });
        if (pdfReal) {
          log(`  URL real: ${pdfReal.substring(0, 100)}…`);
          urlPdf = pdfReal;
        }
      }

      const buffer = await descargarPdf(page, urlPdf);

      if (!buffer) {
        resultados.push({
          guiaNum:     tarea.guiaNum,
          pdfUrl:      urlPdf,
          error:       "Descarga fallida",
          codigosGA:   [],
          raps:        [],
          textoMuestra: null,
        });
        continue;
      }

      // Guardar copia local
      const filename = `probe-h3-guia${String(tarea.guiaNum).padStart(2, "0")}.pdf`;
      fs.writeFileSync(filename, buffer);
      log(`  Guardado: ${filename}`);

      const { texto, codigosGA, raps } = await parsearPdf(buffer, tarea.guiaNum);

      resultados.push({
        guiaNum:      tarea.guiaNum,
        pdfUrl:       urlPdf,
        archivoPdf:   filename,
        codigosGA,
        raps,
        textoMuestra: texto ? texto.substring(0, 600) : null,
      });
    }

    // ── Guardar resultado ────────────────────────────────────────────────────
    const outPath = "probe-h3-resultado.json";
    fs.writeFileSync(outPath, JSON.stringify(resultados, null, 2));
    log(`\n✅ Resultado guardado en ${outPath}`);

    // ── Resumen ──────────────────────────────────────────────────────────────
    log("\n╔══════════════════════════════════════════════════╗");
    log("║  RESUMEN H3 — PDFs parseados                     ║");
    log("╠══════════════════════════════════════════════════╣");

    let totalCodigos = 0;
    let totalRaps    = 0;

    for (const r of resultados) {
      log(`║  Guía ${String(r.guiaNum).padStart(2, "0")}:`);
      log(`║    Códigos GA : ${r.codigosGA?.length ?? 0}`);
      log(`║    RAPs       : ${r.raps?.length ?? 0}`);
      if (r.raps?.length > 0) {
        r.raps.forEach(rap => log(`║      RAP${rap.rapNum}: ${rap.descripcion.substring(0, 60)}…`));
      }
      totalCodigos += r.codigosGA?.length ?? 0;
      totalRaps    += r.raps?.length ?? 0;
    }

    log("╠══════════════════════════════════════════════════╣");
    log(`║  Total códigos GA: ${totalCodigos}`);
    log(`║  Total RAPs con descripción: ${totalRaps}`);
    log("╠══════════════════════════════════════════════════╣");

    if (totalRaps > 0) {
      log("║  ✅ Se pueden crear RAPs con descripción real desde los PDFs.");
      log("║  → Combinar con H1 para crear Rap + RapEvidenciaRel en DB.");
    } else if (totalCodigos > 0) {
      log("║  ✅ Códigos GA en PDF pero sin descripción RAP estructurada.");
      log("║  → Usa H1 para estructura + textoMuestra del PDF para descripción manual.");
    } else {
      log("║  ⚠  No se encontró información en los PDFs.");
      log("║  → Revisa probe-h3-guia*.pdf manualmente.");
      log("║  → El formato del PDF puede ser imagen escaneada (sin OCR).");
    }
    log("╚══════════════════════════════════════════════════╝\n");

  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
