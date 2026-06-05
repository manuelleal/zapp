/**
 * scraper/probeH3PdfBatch.js — Hipótesis 3: Parseo batch de PDFs de Guías
 *
 * MISIÓN: Descargar cada PDF encontrado por H2, parsear su texto con pdf-parse
 * y extraer las descripciones reales de RAP usando el formato estándar SENA.
 *
 * FORMATO SENA ESTÁNDAR (referencia: Guía 6):
 *   Primera página, sección "Resultados de aprendizaje a alcanzar:"
 *   Cada RAP aparece con el patrón:  \d{9}-\d{2}
 *   Ejemplo:
 *     Resultados de aprendizaje a alcanzar:
 *     240202501-06 Comprender textos en inglés...
 *     220501096-02 Analizar requerimientos...
 *
 * MAPEO (GA, AA) → RAP:
 *   Los RAPs se listan en orden dentro del bloque.
 *   El primero listado corresponde a AA1 de la guía, el segundo a AA2, etc.
 *   Este orden se valida cruzando con los datos de Evidencia de la DB.
 *
 * ENTRADAS:
 *   probe-h2-resultado.json   (generado por probeH2GuiasIterator.js)
 *
 * SALIDAS:
 *   probe-h3-guia01.pdf …     copias locales de los PDFs descargados
 *   probe-h3-resultado.json   mapa completo (GA, AA) → { codigo, descripcion }
 *
 * Uso:
 *   node scraper/probeH3PdfBatch.js
 *   node scraper/probeH3PdfBatch.js <path-a-h2-resultado.json>
 *
 * Requiere:
 *   npm install pdf-parse   (ya instalado si corriste H2 antes)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs    = require("fs");
const path  = require("path");
const { chromium }                          = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt }                           = require("../api/src/lib/crypto");
const prisma                                = require("../api/src/db/client");

// ── Regex de extracción SENA ──────────────────────────────────────────────────

/**
 * Localiza el bloque "Resultados de aprendizaje a alcanzar:" en el texto del PDF.
 * El bloque termina cuando aparece otra sección o se agotan ~3000 chars.
 */
const BLOQUE_RAP_REGEX =
  /Resultados?\s+de\s+aprendizaje\s+a\s+alcanzar\s*[:\n]([\s\S]{0,3000})/i;

/**
 * Código SENA de RAP: 9 dígitos (competencia) + guión + 2 dígitos (número RAP).
 * Captura: (1) código completo, (2) competencia 9-dig, (3) número 2-dig, (4) descripción.
 *
 * Maneja formatos:
 *   240202501-06 Comprender textos en inglés...
 *   240202501-06: Comprender textos en inglés...
 *   • 240202501-06 - Comprender textos...
 */
const RAP_ENTRY_REGEX =
  /(\d{9})-(\d{2})\s*[:\-\.\s]+([A-ZÁÉÍÓÚÑ][^\n\d]{10,400})/g;

/**
 * Fallback: captura "RAP N:" o "RAP N -" cuando el formato SENA estricto no aparece.
 * Útil para guías más antiguas o formatos alternativos.
 */
const RAP_FALLBACK_REGEX =
  /(?:^|\n)\s*(?:RAP|Resultado\s+de\s+Aprendizaje)\s*(\d+)\s*[:\-\.]\s*([^\n]{10,400})/gi;

// ── Extracción ────────────────────────────────────────────────────────────────

/**
 * Extrae el bloque "Resultados de aprendizaje a alcanzar:" del texto completo del PDF.
 * Devuelve el substring del bloque o null si no se encontró.
 */
function extraerBloque(textoPdf) {
  const m = textoPdf.match(BLOQUE_RAP_REGEX);
  if (!m) {
    log("  [extracción] ⚠  Bloque 'Resultados de aprendizaje' NO encontrado en el PDF.");
    log("  [extracción]    Muestra del texto (primeros 800 chars):");
    log(`  ${textoPdf.substring(0, 800).replace(/\n/g, "\n  ")}`);
    return null;
  }
  const bloque = m[1];
  log(`  [extracción] ✅ Bloque encontrado (${bloque.length} chars):`);
  log(`  ${bloque.substring(0, 600).replace(/\n/g, "\n  ")}`);
  return bloque;
}

/**
 * Parsea los RAPs del bloque usando el patrón SENA estándar (\d{9}-\d{2}).
 * Si no encuentra ninguno, intenta el fallback "RAP N: descripción".
 * Devuelve array de { codigoSena, competenciaCodigo, rapNumGlobal, descripcion }.
 */
function parsearRapsDelBloque(bloque, textoCompleto) {
  const raps = [];

  // ── Intento 1: formato SENA estándar ────────────────────────────────────
  log("  [parseo] Buscando formato SENA \\d{9}-\\d{2}...");
  for (const m of bloque.matchAll(RAP_ENTRY_REGEX)) {
    const descripcion = m[3].replace(/\s+/g, " ").trim();
    log(`  [parseo]   Encontrado: ${m[1]}-${m[2]} → "${descripcion.substring(0, 80)}"`);
    raps.push({
      codigoSena:        `${m[1]}-${m[2]}`,
      competenciaCodigo: m[1],
      rapNumGlobal:      parseInt(m[2], 10),
      descripcion,
    });
  }

  if (raps.length > 0) {
    log(`  [parseo] ✅ ${raps.length} RAP(s) con formato SENA estándar.`);
    return raps;
  }

  // ── Intento 2: fallback "RAP N: descripción" ────────────────────────────
  log("  [parseo] Formato SENA no encontrado. Intentando fallback 'RAP N:'...");
  for (const m of textoCompleto.matchAll(RAP_FALLBACK_REGEX)) {
    const descripcion = m[2].replace(/\s+/g, " ").trim();
    log(`  [parseo]   Fallback: RAP${m[1]} → "${descripcion.substring(0, 80)}"`);
    raps.push({
      codigoSena:        null,
      competenciaCodigo: null,
      rapNumGlobal:      parseInt(m[1], 10),
      descripcion,
    });
  }

  if (raps.length > 0) {
    log(`  [parseo] ⚠  ${raps.length} RAP(s) por fallback (sin código SENA).`);
  } else {
    log("  [parseo] ❌ No se extrajo ningún RAP.");
  }
  return raps;
}

/**
 * Mapea los RAPs extraídos del PDF a las actividades (AA) de la guía.
 * El primer RAP listado → AA1, el segundo → AA2, etc.
 * Devuelve map: aaNum → { codigoSena, descripcion }
 */
function mapearRapsAANum(raps, guiaNum) {
  const mapa = {};
  raps.forEach((rap, idx) => {
    const aaNum = idx + 1;
    log(`  [mapeo] GA${guiaNum}-AA${aaNum} ← ${rap.codigoSena || `RAP${rap.rapNumGlobal}`}: "${rap.descripcion.substring(0, 60)}"`);
    mapa[aaNum] = {
      codigoSena:    rap.codigoSena,
      competencia:   rap.competenciaCodigo,
      rapNumGlobal:  rap.rapNumGlobal,
      descripcion:   rap.descripcion,
    };
  });
  return mapa;
}

// ── Descarga de PDF ───────────────────────────────────────────────────────────

/**
 * Descarga un PDF usando las cookies de sesión activas del browser.
 * Si la URL es un visor Moodle (mod/resource/view), navega primero para
 * obtener la URL directa del pluginfile.
 * Devuelve Buffer con los bytes del PDF, o null si falla.
 */
async function descargarPdf(page, urlOriginal) {
  let urlPdf = urlOriginal;

  // Si es visor Moodle, navegar para resolver la URL real del archivo
  if (/mod\/resource\/view/i.test(urlPdf)) {
    log(`  [descarga] URL es visor Moodle — resolviendo URL real...`);
    await page.goto(urlPdf, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await cerrarModal(page);

    // Buscar el link/iframe/embed del PDF real en la página del visor
    const urlReal = await page.evaluate(() => {
      for (const sel of ["a[href]", "iframe[src]", "embed[src]", "object[data]"]) {
        for (const el of document.querySelectorAll(sel)) {
          const u = el.href || el.src || el.data || "";
          if (/pluginfile.*\.pdf|pluginfile.*forcedownload/i.test(u)) return u;
        }
      }
      // Fallback: cualquier link de pluginfile
      for (const a of document.querySelectorAll("a[href]")) {
        if (/pluginfile/i.test(a.href)) return a.href;
      }
      return null;
    });

    if (urlReal) {
      log(`  [descarga] URL real del PDF: ${urlReal.substring(0, 100)}`);
      urlPdf = urlReal;
    } else {
      log("  [descarga] ⚠  No se encontró URL real — intentando URL original.");
    }
  }

  log(`  [descarga] Descargando: ${urlPdf.substring(0, 100)}…`);

  // Fetch dentro del contexto del browser para heredar las cookies de sesión
  const result = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      const buf = await res.arrayBuffer();
      return { ok: true, bytes: Array.from(new Uint8Array(buf)), size: buf.byteLength };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, urlPdf);

  if (!result.ok) {
    log(`  [descarga] ❌ Falló: ${result.error}`);
    return null;
  }

  log(`  [descarga] ✅ ${result.size.toLocaleString()} bytes recibidos.`);
  return Buffer.from(result.bytes);
}

/**
 * Parsea un Buffer de PDF con pdf-parse.
 * Devuelve { texto, numPaginas } o null si pdf-parse no está instalado.
 */
async function parsearBufferPdf(buffer, guiaNum) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    log("  [pdf-parse] ❌ No instalado. Ejecuta: npm install pdf-parse");
    return null;
  }

  try {
    const data = await pdfParse(buffer);
    log(`  [pdf-parse] GA${guiaNum}: ${data.numpages} páginas, ${data.text.length.toLocaleString()} chars de texto`);
    log(`  [pdf-parse] Primeros 400 chars del texto extraído:`);
    log(`  "${data.text.substring(0, 400).replace(/\n/g, "↵")}"`);
    return { texto: data.text, numPaginas: data.numpages };
  } catch (e) {
    log(`  [pdf-parse] ❌ Error parseando: ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const h2File = process.argv[2] || "probe-h2-resultado.json";

  // ── Leer resultado de H2 ───────────────────────────────────────────────────
  if (!fs.existsSync(h2File)) {
    console.error(`\n❌ Archivo no encontrado: ${h2File}`);
    console.error("  Ejecuta primero: node scraper/probeH2GuiasIterator.js");
    process.exit(1);
  }

  const h2        = JSON.parse(fs.readFileSync(h2File, "utf-8"));
  const guias     = h2.guias || [];
  const courseId  = h2.courseId;
  log(`\n[H3] Leyendo: ${h2File}  (${guias.length} guías, courseId=${courseId})`);

  // Construir lista de tareas: una entrada por cada (guiaNum, pdfUrl)
  const tareas = [];
  for (const g of guias) {
    for (const url of (g.pdfUrls || [])) {
      tareas.push({ guiaNum: g.guiaNum, pdfUrl: url });
    }
  }

  log(`[H3] PDFs a procesar: ${tareas.length}`);
  tareas.forEach((t, i) => log(`  ${i + 1}. GA${t.guiaNum}: ${t.pdfUrl.substring(0, 80)}`));

  if (tareas.length === 0) {
    console.log("\n⚠  No hay PDFs en probe-h2-resultado.json.");
    console.log("  → Revisa los screenshots probe-h2-guia*.png.");
    console.log("  → Los PDFs pueden estar en un iframe o requerir navegación directa.");
    process.exit(0);
  }

  // ── Obtener ficha para sesión Moodle ──────────────────────────────────────
  const ficha = await prisma.ficha.findFirst({
    where:   { courseId: Number(courseId), archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true } } },
  });

  if (!ficha) {
    console.error("❌ No hay ficha para courseId=" + courseId);
    await prisma.$disconnect();
    return;
  }

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  // headless:true para el batch de descarga (no necesitamos verlo)
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Acumulador de resultados por (guiaNum, aaNum)
  const resultados = [];

  try {
    // Login y warm-up en el curso
    await login(page, zajunaUser, zajunaPass);
    await page.goto(`${BASE_URL}/course/view.php?id=${courseId}`, { waitUntil: "domcontentloaded" });
    await cerrarModal(page);
    log("[H3] Sesión establecida ✓");

    // ── Procesar cada PDF ──────────────────────────────────────────────────
    for (const tarea of tareas) {
      const { guiaNum, pdfUrl } = tarea;
      const pad = String(guiaNum).padStart(2, "0");
      log(`\n${"═".repeat(60)}`);
      log(`  PROCESANDO GA${pad}  —  ${pdfUrl.substring(0, 80)}…`);
      log(`${"═".repeat(60)}`);

      // 1. Descargar
      const buffer = await descargarPdf(page, pdfUrl);
      if (!buffer) {
        resultados.push({ guiaNum, pdfUrl, error: "Descarga fallida", rapsEncontrados: [], mapaAA: {} });
        continue;
      }

      // 2. Guardar copia local
      const pdfFile = `probe-h3-guia${pad}.pdf`;
      fs.writeFileSync(pdfFile, buffer);
      log(`  [guardado] ${pdfFile}  (${buffer.length.toLocaleString()} bytes)`);

      // 3. Parsear texto del PDF
      const parsed = await parsearBufferPdf(buffer, guiaNum);
      if (!parsed) {
        resultados.push({ guiaNum, pdfUrl, pdfFile, error: "pdf-parse no disponible", rapsEncontrados: [], mapaAA: {} });
        continue;
      }

      const { texto } = parsed;

      // 4. Extraer bloque SENA
      const bloque = extraerBloque(texto);

      // 5. Parsear RAPs del bloque (con fallback al texto completo)
      const rapsEncontrados = parsearRapsDelBloque(bloque || texto, texto);

      // 6. Mapear a (AA) por orden de aparición
      const mapaAA = mapearRapsAANum(rapsEncontrados, guiaNum);

      resultados.push({
        guiaNum,
        pdfUrl,
        pdfFile,
        numPaginas:    parsed.numPaginas,
        rapsEncontrados,
        mapaAA,
        textoMuestra:  texto.substring(0, 800),
      });
    }

    // ── Guardar resultado ──────────────────────────────────────────────────
    const outFile = "probe-h3-resultado.json";
    fs.writeFileSync(outFile, JSON.stringify(resultados, null, 2));
    log(`\n✅ Resultado guardado: ${outFile}`);

    // ── Reporte consolidado ────────────────────────────────────────────────
    log(`\n${"╔" + "═".repeat(58) + "╗"}`);
    log("║  REPORTE CONSOLIDADO H3 — Descripciones RAP por (GA, AA)   ║");
    log(`${"╠" + "═".repeat(58) + "╣"}`);

    // Construir tabla completa de (GA, AA) con descripción
    const tablaFinal = [];
    let conDescripcion = 0;
    let sinDescripcion = 0;

    for (const r of resultados.sort((a, b) => a.guiaNum - b.guiaNum)) {
      if (r.error) {
        log(`║  GA${String(r.guiaNum).padStart(2,"0")}: ERROR — ${r.error}`);
        continue;
      }
      const aaKeys = Object.keys(r.mapaAA).sort();
      if (aaKeys.length === 0) {
        log(`║  GA${String(r.guiaNum).padStart(2,"0")}: ⚠  Sin RAPs extraídos`);
        sinDescripcion++;
        continue;
      }
      for (const aaNumStr of aaKeys) {
        const aaNum = parseInt(aaNumStr, 10);
        const rap   = r.mapaAA[aaNumStr];
        const desc  = rap.descripcion.substring(0, 55);
        log(`║  GA${String(r.guiaNum).padStart(2,"0")}-AA${aaNum}  ${rap.codigoSena || "sin-código"}  "${desc}…"`);
        tablaFinal.push({ guiaNum: r.guiaNum, aaNum, ...rap });
        conDescripcion++;
      }
    }

    log(`${"╠" + "═".repeat(58) + "╣"}`);
    log(`║  RAPs con descripción : ${conDescripcion}`);
    log(`║  Slots sin descripción: ${sinDescripcion}`);
    log(`${"╠" + "═".repeat(58) + "╣"}`);

    // Cruzar con los 12 slots esperados según H1
    const slotsEsperados = [
      "GA01-AA1","GA01-AA2",
      "GA02-AA1","GA02-AA2",
      "GA03-AA1","GA03-AA2",
      "GA04-AA1","GA04-AA2",
      "GA05-AA1","GA05-AA2",
      "GA06-AA1",
      "GA07-AA1",
    ];
    const encontrados = new Set(tablaFinal.map(t => `GA${String(t.guiaNum).padStart(2,"0")}-AA${t.aaNum}`));
    const faltantes   = slotsEsperados.filter(s => !encontrados.has(s));

    if (faltantes.length > 0) {
      log(`║  Slots sin PDF aún: ${faltantes.join(", ")}`);
    } else {
      log("║  ✅ Todos los slots cubiertos.");
    }
    log(`${"╚" + "═".repeat(58) + "╝"}\n`);

    // Guardar tabla final por separado para fácil lectura
    fs.writeFileSync("probe-h3-tabla-raps.json", JSON.stringify(tablaFinal, null, 2));
    log("✅ Tabla final: probe-h3-tabla-raps.json\n");

  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
