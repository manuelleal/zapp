/**
 * Extractor genérico de Competencias y RAPs desde guías de aprendizaje SENA (PDF).
 *
 * Uso:
 *   node scripts/extraerTodasLasGuias.js <ruta.pdf> [--dry-run]
 *
 * Ejemplo:
 *   node scripts/extraerTodasLasGuias.js C:\zajuna\Guia_aprendizaje_3.pdf
 *   node scripts/extraerTodasLasGuias.js C:\zajuna\Guia_aprendizaje_3.pdf --dry-run
 *
 * Secciones que parsea:
 *   "Competencia(s):"                       → prisma.competencia.upsert
 *   "Resultados de aprendizaje a alcanzar:" → prisma.rAP.upsert
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs    = require("fs");
const path  = require("path");
const prisma = require("../api/src/db/client");

const DRY_RUN = process.argv.includes("--dry-run");
const pdfArg  = process.argv.find(a => !a.startsWith("-") && a.toLowerCase().endsWith(".pdf"));

if (!pdfArg) {
  console.error("Uso: node scripts/extraerTodasLasGuias.js <ruta.pdf> [--dry-run]");
  process.exit(1);
}

const PDF_PATH = path.resolve(pdfArg);

function log(...args) { console.log(new Date().toISOString(), ...args); }

// ─── Limpieza de texto bruto del PDF ────────────────────────────────────────
function limpiarTexto(t) {
  return t
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ")   // "-- 1 of 5 --"
    .replace(/GFPI-F-\d+\s+V\.?\s*\d+/gi, " ")      // cabeceras de plantilla SENA
    .replace(/\r\n/g, "\n");
}

// ─── Extracción de bloque entre dos secciones ────────────────────────────────
// Retorna el texto desde el final del match de inicioRe hasta el inicio de finRe.
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

// ─── Parser de Competencias ──────────────────────────────────────────────────
// Busca códigos de exactamente 9 dígitos que NO estén seguidos de "-NN"
// (eso los distingue de los códigos de RAP).
// El nombre corre hasta el siguiente código de 9 dígitos o fin de bloque.
function extraerCompetencias(bloque) {
  const RE = /\b(\d{9})\b(?!-\d{2})\s*[-–]?\s*([^\n]+(?:\n(?!\s*\d{9})[^\n]*)*)/g;
  const resultados = [];
  let m;
  while ((m = RE.exec(bloque)) !== null) {
    const codigo = m[1].trim();
    let nombre = m[2].replace(/\s+/g, " ").trim();
    
    // Truncar basura: viñetas gruesas o el inicio de "Duración" o "2. PRESENTACIÓN"
    const cutIdx = nombre.search(/(\s•\s|\. |\s-\sDuración|\sDuración|\s2\.\sPRESENTACIÓN)/i);
    if (cutIdx > 0) nombre = nombre.substring(0, cutIdx).trim();
    if (nombre.endsWith(".")) nombre = nombre.substring(0, nombre.length - 1);
    
    if (nombre.length > 5 && nombre.length < 300) {
      resultados.push({ codigo, nombre });
    }
  }
  return resultados;
}

// ─── Parser de RAPs ─────────────────────────────────────────────────────────
// Busca entradas con los dos formatos reales encontrados en PDFs de guías SENA:
//
//   Formato A (guías de inglés / algunos programas):
//     • 240202501-05: Presentar un proceso para la realización...
//     • Duración de la guía: 232 horas
//
//   Formato B (mayoría de guías técnicas):
//     o 220501092-01 - Caracterizar los procesos de la organización...
//     o 220501092-02 - Recolectar información del software...
//
// Estrategia del regex:
//   1. Ancla en la viñeta `•` (Unicode •) O en `o ` (letra O minúscula al inicio
//      de línea — estilo de bala usado por la plantilla GFPI-F-135).
//      Ambas formas son toleradas; también acepta el código sin viñeta precedente.
//   2. Captura el código 9-2 dígitos seguido de separador `:` o `-` o `–`.
//   3. La descripción termina en el PRIMER punto seguido de espacio/salto
//      (primera oración completa), o en cualquiera de los delimitadores de cierre:
//        - siguiente viñeta • o `o ` seguido de código
//        - "Duración" (introduce la línea de horas, NO es descripción)
//        - "PRESENTACIÓN" / "FORMULACIÓN" (secciones del documento)
//        - siguiente código RAP (\d{9}-\d{2})
//        - fin del bloque
//   4. Red de seguridad: .substring(0, 300) si ningún punto aparece antes.
//
// Por qué no usar [\s\S]+? hasta \n\n:
//   Los PDFs insertan saltos de página (-- N of M --) dentro de un RAP, rompiendo
//   la línea en blanco como delimitador. El regex anterior capturaba todo hasta el
//   próximo párrafo vacío, arrastando texto de otras secciones.
function extraerRAPs(bloque) {
  // Viñeta: acepta • (Unicode) o `o` al inicio de línea (plantilla GFPI-F-135).
  // El `(?:^|\n)\s*` asegura que la `o` esté al inicio de línea, no dentro de palabra.
  // Separador tras el código: `:` (formato A) o `-`/`–` (formato B).
  const RE = /(?:(?:^|\n)\s*[•o]\s*)(\d{9}-\d{2})\s*[-–:]\s*([\s\S]+?)(?=[•o]\s*\d{9}|[•o]\s*Duraci[oó]n|\bDuraci[oó]n\b|\bPRESENTACI[OÓ]N\b|\bFORMULACI[OÓ]N\b|\b\d{9}-\d{2}\b|\n[ \t]*\n|$)/gim;

  const resultados = [];
  let m;
  while ((m = RE.exec(bloque)) !== null) {
    const codigo = m[1].trim();
    let descripcion = m[2]
      // Quitar artefactos de paginación del PDF (ej: "-- 1 of 40 --", "GFPI-F-135 V02")
      .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
      .replace(/GFPI-F-\d+\s+V\.?\s*\d+/gi, "")
      // Colapsar saltos de línea internos y espacios múltiples a espacio simple
      .replace(/\s+/g, " ")
      .trim();

    // Tomar solo la primera oración completa (hasta el primer ". " o ".$").
    // Los RAPs SENA son siempre oraciones únicas; todo lo que siga al primer punto
    // pertenece a la siguiente entrada o a texto de sección.
    // Se ignoran puntos en los primeros 20 chars para no cortar siglas/acrónimos cortos.
    const primerPunto = descripcion.search(/\.(?:\s|$)/);
    if (primerPunto > 20) {
      // Incluir el punto para conservar la puntuación natural de la descripción
      descripcion = descripcion.substring(0, primerPunto + 1).trim();
    }

    // Red de seguridad: si no hubo punto o la oración es enorme, cortar a 300 chars
    if (descripcion.length > 300) {
      descripcion = descripcion.substring(0, 300).trim();
    }

    if (descripcion.length > 5) {
      resultados.push({
        codigo,
        competenciaCodigo: codigo.split("-")[0],
        descripcion,
      });
    }
  }
  return resultados;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`❌ Archivo no encontrado: ${PDF_PATH}`);
    process.exit(1);
  }

  log(`Leyendo PDF: ${PDF_PATH}`);
  const buffer = fs.readFileSync(PDF_PATH);

  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const data = await parser.getText().catch(e => {
    console.error("❌ Error al leer PDF:", e.message);
    process.exit(1);
  });
  await parser.destroy().catch(() => {});

  const texto = limpiarTexto(data.text);

  // Fin de sección: encabezados comunes en guías SENA.
  // "Resultados de aprendizaje" está incluido para cortar el bloque de Competencias.
  const FIN_SECCION = /\n\s*(?:Resultados de aprendizaje|Actividad(?:es)? de aprendizaje|Presentaci[oó]n|Formulaci[oó]n\s+de|Introducción|Duración|Ambiente|Materiales|Evidencias de aprendizaje|Fecha|Criterios)/i;

  // Acepta: "Competencia(s):", "Competencias:", "Competencia:"
  const bloqueComp = bloqueSeccion(
    texto,
    /Competencia(?:s|\(s\))?\s*:/i,
    FIN_SECCION,
  );

  // Acepta: "Resultados de aprendizaje a alcanzar:", "Resultados de aprendizaje:"
  const bloqueRap = bloqueSeccion(
    texto,
    /Resultados de aprendizaje(?: a alcanzar)?\s*:/i,
    FIN_SECCION,
  );

  if (!bloqueComp) {
    console.error('❌ No se encontró sección de Competencias en el PDF (buscado: "Competencia(s):" / "Competencias:").');
    process.exit(1);
  }
  if (!bloqueRap) {
    console.error('❌ No se encontró sección de RAPs en el PDF (buscado: "Resultados de aprendizaje a alcanzar:" / "Resultados de aprendizaje:").');
    process.exit(1);
  }

  const competencias = extraerCompetencias(bloqueComp);
  const raps         = extraerRAPs(bloqueRap);

  // ─── Resumen de extracción ───────────────────────────────────────────────
  console.log("\n╔══ EXTRACCIÓN ═══════════════════════════════════════════════════╗");
  console.log(`║  Competencias encontradas : ${competencias.length}`);
  console.log(`║  RAPs encontrados         : ${raps.length}`);
  console.log("╠═════════════════════════════════════════════════════════════════╣");
  for (const c of competencias) {
    console.log(`║  COMP  [${c.codigo}]  ${c.nombre.substring(0, 55).padEnd(55)} ║`);
  }
  for (const r of raps) {
    console.log(`║  RAP   [${r.codigo}]  ${r.descripcion.substring(0, 51).padEnd(51)} ║`);
  }
  console.log("╚═════════════════════════════════════════════════════════════════╝\n");

  if (competencias.length === 0 && raps.length === 0) {
    console.warn("⚠ No se extrajo nada. Revisa que el PDF contenga el texto esperado.");
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    log("⚠ DRY RUN — nada se escribe en DB.");
    await prisma.$disconnect();
    return;
  }

  // ─── Upsert Competencias ─────────────────────────────────────────────────
  const competenciaMap = new Map(); // codigo → registro DB

  for (const c of competencias) {
    const rec = await prisma.competencia.upsert({
      where:  { codigo: c.codigo },
      create: { codigo: c.codigo, nombre: c.nombre },
      update: { nombre: c.nombre },
    });
    competenciaMap.set(c.codigo, rec);
    log(`✅ Competencia: ${rec.id} [${c.codigo}]`);
  }

  // Para RAPs cuya competencia no aparece en el PDF, buscar en DB o crear placeholder
  for (const r of raps) {
    if (competenciaMap.has(r.competenciaCodigo)) continue;
    const existing = await prisma.competencia.findUnique({ where: { codigo: r.competenciaCodigo } });
    if (existing) {
      competenciaMap.set(r.competenciaCodigo, existing);
    } else {
      log(`⚠ Competencia ${r.competenciaCodigo} no listada en PDF — creando placeholder`);
      const rec = await prisma.competencia.create({
        data: { codigo: r.competenciaCodigo, nombre: `[Sin nombre — ${path.basename(PDF_PATH)}]` },
      });
      competenciaMap.set(r.competenciaCodigo, rec);
    }
  }

  // ─── Upsert RAPs ─────────────────────────────────────────────────────────
  let guardados = 0;
  for (const r of raps) {
    const comp = competenciaMap.get(r.competenciaCodigo);
    if (!comp) {
      log(`⚠ RAP ${r.codigo} ignorado — competencia ${r.competenciaCodigo} no disponible`);
      continue;
    }
    await prisma.rAP.upsert({
      where:  { competenciaId_codigo: { competenciaId: comp.id, codigo: r.codigo } },
      create: { competenciaId: comp.id, codigo: r.codigo, descripcion: r.descripcion },
      update: { descripcion: r.descripcion },
    });
    log(`✅ RAP: ${r.codigo} — "${r.descripcion.substring(0, 60)}"`);
    guardados++;
  }

  console.log(`\n✔ Completado: ${competencias.length} competencia(s), ${guardados} RAP(s) guardados en DB.\n`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
