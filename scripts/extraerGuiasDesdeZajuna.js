/**
 * extraerGuiasDesdeZajuna.js
 *
 * Descarga todas las Guías de Aprendizaje directamente desde el curso en Zajuna,
 * extrae Competencias y RAPs de cada PDF, y hace upsert en DB.
 *
 * Uso:
 *   node scripts/extraerGuiasDesdeZajuna.js [courseId] [--dry-run]
 *
 * Ejemplo:
 *   node scripts/extraerGuiasDesdeZajuna.js 50283
 *   node scripts/extraerGuiasDesdeZajuna.js 50283 --dry-run
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { chromium } = require("playwright");
const prisma  = require("../api/src/db/client");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");

const COURSE_ID = process.argv.find(a => /^\d+$/.test(a)) || "50283";
const DRY_RUN   = process.argv.includes("--dry-run");
const USER      = process.env.ZAJUNA_USER;
const PASS      = process.env.ZAJUNA_PASS;

// ─── Texto helpers (idénticos a extraerTodasLasGuias.js) ─────────────────────

function limpiarTexto(t) {
  return t
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ")
    .replace(/GFPI-F-\d+\s+V\.?\s*\d+/gi, " ")
    .replace(/\r\n/g, "\n");
}

function bloqueSeccion(texto, inicioRe, finRe) {
  inicioRe.lastIndex = 0;
  const mInicio = inicioRe.exec(texto);
  if (!mInicio) return null;
  const desde = mInicio.index + mInicio[0].length;
  const resto  = texto.slice(desde);
  finRe.lastIndex = 0;
  const mFin = finRe.exec(resto);
  return mFin ? resto.slice(0, mFin.index) : resto;
}

function extraerCompetencias(bloque) {
  const RE = /\b(\d{9})\b(?!-\d{2})\s*[-–]?\s*([^\n]+(?:\n(?!\s*\d{9})[^\n]*)*)/g;
  const out = [];
  let m;
  while ((m = RE.exec(bloque)) !== null) {
    const nombre = m[2].replace(/\s+/g, " ").trim();
    if (nombre.length > 5) out.push({ codigo: m[1].trim(), nombre });
  }
  return out;
}

function extraerRAPs(bloque) {
  const RE = /\b(\d{9}-\d{2})\b\s*[-–]?\s*([\s\S]+?)(?=\b\d{9}-\d{2}\b|$)/g;
  const out = [];
  let m;
  while ((m = RE.exec(bloque)) !== null) {
    const descripcion = m[2]
      .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
      .replace(/GFPI-F-\d+\s+V\.?\s*\d+/gi, "")
      .replace(/\s+/g, " ").trim();
    if (descripcion.length > 5) out.push({ codigo: m[1].trim(), competenciaCodigo: m[1].split("-")[0], descripcion });
  }
  return out;
}

// ─── Parsear buffer PDF → { competencias, raps } ────────────────────────────

async function parsearPDF(buffer, nombreArchivo) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const data = await parser.getText().catch(() => null);
  await parser.destroy().catch(() => {});
  if (!data) return null;

  const texto = limpiarTexto(data.text);
  const FIN   = /\n\s*(?:Resultados de aprendizaje|Actividad(?:es)? de aprendizaje|Introducción|Duración|Ambiente|Materiales|Evidencias de aprendizaje|Fecha|Criterios)/i;

  const bloqueComp = bloqueSeccion(texto, /Competencia(?:s|\(s\))?\s*:/i, FIN);
  const bloqueRap  = bloqueSeccion(texto, /Resultados de aprendizaje(?: a alcanzar)?\s*:/i, FIN);

  if (!bloqueComp && !bloqueRap) {
    console.log(`  ⚠  Sin secciones SENA reconocibles — ¿no es una guía de aprendizaje?`);
    return null;
  }

  return {
    competencias: bloqueComp ? extraerCompetencias(bloqueComp) : [],
    raps:         bloqueRap  ? extraerRAPs(bloqueRap)          : [],
  };
}

// ─── Guardar en DB ───────────────────────────────────────────────────────────

async function guardarEnDB(competencias, raps, origen) {
  const competenciaMap = new Map();

  for (const c of competencias) {
    const rec = await prisma.competencia.upsert({
      where:  { codigo: c.codigo },
      create: { codigo: c.codigo, nombre: c.nombre },
      update: { nombre: c.nombre },
    });
    competenciaMap.set(c.codigo, rec);
    console.log(`    ✅ Competencia [${c.codigo}] ${c.nombre.substring(0, 50)}`);
  }

  for (const r of raps) {
    if (!competenciaMap.has(r.competenciaCodigo)) {
      const ex = await prisma.competencia.findUnique({ where: { codigo: r.competenciaCodigo } });
      if (ex) competenciaMap.set(r.competenciaCodigo, ex);
      else {
        const rec = await prisma.competencia.create({
          data: { codigo: r.competenciaCodigo, nombre: `[Sin nombre — ${origen}]` },
        });
        competenciaMap.set(r.competenciaCodigo, rec);
      }
    }
    const comp = competenciaMap.get(r.competenciaCodigo);
    if (!comp) continue;
    await prisma.rAP.upsert({
      where:  { competenciaId_codigo: { competenciaId: comp.id, codigo: r.codigo } },
      create: { competenciaId: comp.id, codigo: r.codigo, descripcion: r.descripcion },
      update: { descripcion: r.descripcion },
    });
    console.log(`    ✅ RAP [${r.codigo}] ${r.descripcion.substring(0, 55)}`);
  }

  return { nComps: competencias.length, nRaps: raps.length };
}

// ─── Descargar PDF desde una página-guía Moodle (mod/page) ──────────────────
// Cada guía SENA en Zajuna es una página con un botón "Clic aquí para acceder
// al recurso educativo" que hace window.open(urlPDF). Extraemos esa URL y
// descargamos el PDF con las cookies de sesión activas (mismo mecanismo que
// scraper/probes/probeGuiaRecurso.js).

async function descargarRecurso(context, pageUrl) {
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await cerrarModal(page);

    // 1. Buscar window.open('...') en cualquier onclick del DOM
    const windowOpenUrl = await page.evaluate(() => {
      const el = document.querySelector("[onclick*='window.open']");
      if (!el) return null;
      const m = (el.getAttribute("onclick") || "").match(/window\.open\s*\(\s*['"]([^'"]+)['"]/i);
      return m ? m[1] : null;
    });

    let pdfUrl = windowOpenUrl;

    // Si la URL es relativa, prefijamos el dominio
    if (pdfUrl && pdfUrl.startsWith("/") && !pdfUrl.startsWith("//")) {
      pdfUrl = "https://zajuna.sena.edu.co" + pdfUrl;
    }

    // 2. Si no hay window.open, buscar href directo a PDF o pluginfile
    if (!pdfUrl) {
      pdfUrl = await page.evaluate(() => {
        const a = document.querySelector('a[href*=".pdf"], a[href*="pluginfile"]');
        return a ? a.href : null;
      });
    }

    if (!pdfUrl) return null;

    // 3. Descargar usando cookies de sesión (igual que probeGuiaRecurso.js)
    const https   = require("https");
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    const buffer = await new Promise((resolve) => {
      const agent = new https.Agent({ rejectUnauthorized: false });
      https.get(pdfUrl, { headers: { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0" }, agent }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      }).on("error", () => resolve(null));
    });

    if (!buffer || buffer.length < 1000) return null;
    return buffer;

  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Extractor de Guías desde Zajuna — courseId=${COURSE_ID}`);
  if (DRY_RUN) console.log("  MODO DRY-RUN (no escribe en DB)");
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!USER || !PASS) { console.error("ERROR: ZAJUNA_USER / ZAJUNA_PASS no definidos"); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log("[1] Login...");
  await login(page, USER, PASS);
  console.log("    OK\n");

  // ── Buscar recursos del curso ──────────────────────────────────────────────
  console.log(`[2] Buscando recursos en course/view.php?id=${COURSE_ID}...`);
  await page.goto(`${BASE_URL}/course/view.php?id=${COURSE_ID}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await cerrarModal(page);

  // Las guías SENA en Zajuna son páginas Moodle (mod/page), NO archivos adjuntos
  // (mod/resource). Cada página tiene un botón "Clic aquí" con window.open() al PDF.
  const recursos = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/mod/page/view.php"]'));
    return links.map(a => ({
      nombre: (a.textContent || "").replace(/\s+/g, " ").trim(),
      href:   a.href,
    })).filter(r => r.nombre.length > 0);
  });

  console.log(`    Páginas (mod/page) encontradas: ${recursos.length}`);

  // Filtrar por nombre de guía: "Guía", "Guia", "GA01", "Aprendizaje"
  let guias = recursos.filter(r =>
    /gu[ií]a|aprendizaje|^GA\s*\d{1,2}/i.test(r.nombre)
  );

  // Si el filtro no atrapó nada, usar todos los mod/page (puede que los nombres varíen)
  if (guias.length === 0 && recursos.length > 0) {
    console.log("    (Ninguna coincidió por nombre — procesando TODAS las páginas)");
    guias = recursos;
  }

  console.log(`    Que parecen guías   : ${guias.length}`);
  for (const r of guias) console.log(`      • "${r.nombre}"`);
  console.log();

  if (guias.length === 0) {
    console.log("❌ No se encontraron recursos de tipo guía en el curso.");
    await browser.close();
    await prisma.$disconnect();
    return;
  }

  // ── Procesar cada guía ────────────────────────────────────────────────────
  let totalComps = 0;
  let totalRaps  = 0;
  let procesadas = 0;
  let fallidas   = 0;

  for (let i = 0; i < guias.length; i++) {
    const g = guias[i];
    console.log(`\n[${i + 1}/${guias.length}] "${g.nombre}"`);
    console.log(`    URL: ${g.href}`);

    const buffer = await descargarRecurso(context, g.href);
    if (!buffer) {
      console.log("    ⚠  No se pudo descargar (no es PDF o sin acceso).");
      fallidas++;
      continue;
    }
    console.log(`    Descargado: ${(buffer.length / 1024).toFixed(0)} KB`);

    const resultado = await parsearPDF(buffer, g.nombre);
    if (!resultado) { fallidas++; continue; }

    const { competencias, raps } = resultado;
    console.log(`    Competencias: ${competencias.length}  |  RAPs: ${raps.length}`);

    if (competencias.length === 0 && raps.length === 0) {
      console.log("    ⚠  PDF descargado pero sin secciones SENA — saltando.");
      fallidas++;
      continue;
    }

    if (DRY_RUN) {
      for (const c of competencias) console.log(`    [DRY] COMP [${c.codigo}] ${c.nombre.substring(0, 50)}`);
      for (const r of raps)         console.log(`    [DRY] RAP  [${r.codigo}] ${r.descripcion.substring(0, 50)}`);
    } else {
      const stats = await guardarEnDB(competencias, raps, g.nombre);
      totalComps += stats.nComps;
      totalRaps  += stats.nRaps;
    }
    procesadas++;
  }

  await browser.close();

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  RESUMEN`);
  console.log(`  Guías procesadas : ${procesadas}/${guias.length}`);
  console.log(`  Fallidas / skip  : ${fallidas}`);
  if (!DRY_RUN) {
    console.log(`  Competencias     : ${totalComps} upserted`);
    console.log(`  RAPs             : ${totalRaps} upserted`);
  }
  console.log("═══════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(e => { console.error("Error fatal:", e.message); process.exit(1); });
