/**
 * Lee los PDFs guardados (probe-recurso-ga0N.pdf) y siembra los RAPs
 * de inglés (240202501) en la DB para el primer usuario activo.
 *
 * Ejecutar: node scraper/seedRapsIngles.js [--dry-run]
 *
 * Prerrequisito: correr primero probeGuiaRecurso.js (genera los PDFs).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs     = require("fs");
const path   = require("path");
const prisma = require("../api/src/db/client");

const DRY_RUN = process.argv.includes("--dry-run");

// Competencia de inglés del SENA
const COMPETENCIA_CODIGO = "240202501";
const COMPETENCIA_NOMBRE = "Comunicar información teniendo en cuenta los contextos sociales y laborales (inglés)";

// RAPs de inglés por número de guía:
// Cada GA tiene exactamente un RAP de inglés con rapNum = gaNum
const GUIAS = [
  { etiqueta: "GA01", gaNum: 1, archivo: "probe-recurso-ga01.pdf" },
  { etiqueta: "GA02", gaNum: 2, archivo: "probe-recurso-ga02.pdf" },
  { etiqueta: "GA03", gaNum: 3, archivo: "probe-recurso-ga03.pdf" },
  { etiqueta: "GA04", gaNum: 4, archivo: "probe-recurso-ga04.pdf" },
  { etiqueta: "GA05", gaNum: 5, archivo: "probe-recurso-ga05.pdf" },
  { etiqueta: "GA06", gaNum: 6, archivo: "probe-recurso-ga06.pdf" },
];

// Busca 240202501-NN directamente en el texto completo del PDF
// Captura descripción hasta el siguiente bullet "•", RAP code, o sección
const RAP_INGLES_REGEX = /240202501-(\d{2})\s*[-–]\s*([\s\S]+?)(?=\n[•\*]|\no\s+\d{9}|\nClaves?:|\nTécnicas?:|\nTransversales?:|\nClave:|\n\n|--\s*\d+\s+of\s+\d+\s*--|$)/gi;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function extraerRapIngles(pdfBuffer, etiqueta) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
  const data   = await parser.getText().catch(e => null);
  await parser.destroy().catch(() => {});
  if (!data) return null;

  const texto = data.text;
  // Buscar 240202501-NN directamente en el texto completo del PDF
  let matchIngles = null;
  let m;
  RAP_INGLES_REGEX.lastIndex = 0;
  while ((m = RAP_INGLES_REGEX.exec(texto)) !== null) {
    matchIngles = m;  // nos quedamos con el último match (debería ser el único)
  }
  if (!matchIngles) {
    log(`⚠ ${etiqueta}: RAP inglés (240202501-NN) no encontrado`);
    // Verificar si existe sin descripción
    const sinDesc = /240202501-(\d{2})/.exec(texto);
    if (sinDesc) log(`  → Código ${sinDesc[0]} encontrado sin descripción extraíble`);
    return null;
  }

  const rapNum = parseInt(matchIngles[1], 10);
  // Limpiar descripción: colapsar espacios/newlines de forma limpia
  const descripcion = matchIngles[2]
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, "")   // quitar marcadores de página
    .replace(/GFPI-F-135\s+V\d+/g, "")            // quitar encabezados de página
    .replace(/\s+/g, " ")
    .trim();

  return { rapNum, codigo: `${COMPETENCIA_CODIGO}-${String(rapNum).padStart(2, "0")}`, descripcion };
}

async function main() {
  log(DRY_RUN ? "⚠ DRY RUN — no se escribe en DB" : "Sembrando RAPs de inglés en DB...");

  // Obtener o crear la Competencia de inglés
  let competencia;
  if (!DRY_RUN) {
    competencia = await prisma.competencia.upsert({
      where:  { codigo: COMPETENCIA_CODIGO },
      create: { codigo: COMPETENCIA_CODIGO, nombre: COMPETENCIA_NOMBRE },
      update: { nombre: COMPETENCIA_NOMBRE },
    });
    log(`Competencia upserted: ${competencia.id} (${COMPETENCIA_CODIGO})`);

    // Actualizar todos los User que tengan competenciaCodigo = 240202501 para linkear
    const users = await prisma.user.findMany({ where: { competenciaCodigo: COMPETENCIA_CODIGO } });
    for (const u of users) {
      await prisma.user.update({ where: { id: u.id }, data: { competenciaId: competencia.id } });
      log(`  User ${u.email} → competenciaId=${competencia.id}`);
    }
  }

  const resultados = [];

  for (const guia of GUIAS) {
    const archivoPdf = path.resolve(__dirname, "..", guia.archivo);
    if (!fs.existsSync(archivoPdf)) {
      log(`⚠ ${guia.etiqueta}: archivo no existe: ${archivoPdf}`);
      continue;
    }

    const pdfBuffer = fs.readFileSync(archivoPdf);
    const rap = await extraerRapIngles(pdfBuffer, guia.etiqueta);
    if (!rap) continue;

    log(`✅ ${guia.etiqueta} → ${rap.codigo}: "${rap.descripcion.substring(0, 80)}..."`);
    resultados.push(rap);

    if (!DRY_RUN) {
      // Upsert RAP usando la competencia
      await prisma.rAP.upsert({
        where:  { competenciaId_codigo: { competenciaId: competencia.id, codigo: rap.codigo } },
        create: { competenciaId: competencia.id, codigo: rap.codigo, descripcion: rap.descripcion },
        update: { descripcion: rap.descripcion },
      });
      log(`  DB upserted: ${rap.codigo}`);
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RESUMEN — RAPs de inglés extraídos                       ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  for (const r of resultados) {
    console.log(`║  ${r.codigo}  ${r.descripcion.substring(0, 55).padEnd(55)} ║`);
  }
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!DRY_RUN && resultados.length > 0) {
    const total = await prisma.rAP.count({ where: { competencia: { codigo: COMPETENCIA_CODIGO } } });
    log(`Total RAPs en DB para ${COMPETENCIA_CODIGO}: ${total}`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
