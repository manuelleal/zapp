/**
 * importarMapeoRaps.js — Importa un mapeo RAP↔evidencia extraído por IA (Gemini)
 * desde un archivo .md a la DB: crea los `RapEvidenciaRel` y puebla los `Criterio`.
 *
 * Reemplaza la fórmula GA{N}→RAP de inglés (vincularEvidenciasRAPs.js) por el mapeo
 * REAL de las guías técnicas, donde el grano cambia por competencia (por AA o por
 * guía). El .md lo produce Gemini leyendo el PDF de la guía (formato GFPI-F-135).
 *
 * FORMATO ESPERADO DEL .md (ver raps.md):
 *   - Sección 1: tabla con filas | `GA1-220501092-AA1-EV01` | nombre | tipo | `220501092-01` | confianza |
 *     → de cada fila se extrae (codigo_evidencia, RAP_asociado).
 *   - Sección 2: bloques **RAP `220501092-01` ...:** seguidos de  > "criterios..."
 *     → de cada bloque se extrae (rapCodigo, texto de criterios).
 *
 * MATCH evidencia: el codigo_evidencia se busca DENTRO del nombre de cada Evidencia
 * (normalizado sin espacios/mayúsculas), así que enlaza TODAS las filas Evidencia
 * que tengan ese código (en cualquier ficha). Idempotente (upsert).
 *
 * Uso:
 *   node scripts/importarMapeoRaps.js <archivo.md> [--dry-run] [--no-criterios]
 *   node scripts/importarMapeoRaps.js raps.md --dry-run
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");
const prisma = require("../api/src/db/client");

const ARCHIVO       = process.argv.find(a => a.endsWith(".md")) || "raps.md";
const DRY_RUN       = process.argv.includes("--dry-run");
const NO_CRITERIOS  = process.argv.includes("--no-criterios");

// Quita ruido de Gemini ([cite_start], [cite: 12]) y normaliza para comparar códigos.
const limpiarCita = s => String(s).replace(/\[cite_start\]/gi, "").replace(/\[cite:[^\]]*\]/gi, "").trim();
const norm        = s => String(s).toUpperCase().replace(/\s+/g, "");

// ─── Parseo del .md ────────────────────────────────────────────────────────────

function parsearMapeos(texto) {
  // Filas de la tabla: capturan el código de evidencia y el RAP, ambos en backticks.
  const mapeos = [];
  const reEv  = /`\s*(GA\d+-\s*\d{9}-AA\d+-EV\d+)\s*`/i;
  const reRap = /`\s*(\d{9}-\d{2})\s*`/;
  for (const linea of texto.split("\n")) {
    if (!linea.trim().startsWith("|")) continue;
    const mEv  = linea.match(reEv);
    const mRap = linea.match(reRap);
    if (mEv && mRap) {
      mapeos.push({ codigoEvidencia: norm(mEv[1]), rapCodigo: mRap[1].trim() });
    }
  }
  return mapeos;
}

function parsearCriterios(texto) {
  // Bloques:  **RAP `220501092-01` ...:**  \n  > "texto..."
  const criterios = new Map(); // rapCodigo → texto
  const lineas = texto.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const mRap = lineas[i].match(/\*\*RAP\s*`\s*(\d{9}-\d{2})\s*`/);
    if (!mRap) continue;
    // Buscar la primera línea de cita '>' siguiente
    for (let j = i + 1; j < Math.min(i + 4, lineas.length); j++) {
      const mTxt = lineas[j].match(/^\s*>\s*"?(.+?)"?\s*$/);
      if (mTxt) {
        criterios.set(mRap[1].trim(), limpiarCita(mTxt[1]).replace(/^"|"$/g, "").trim());
        break;
      }
    }
  }
  return criterios;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ruta = path.isAbsolute(ARCHIVO) ? ARCHIVO : path.resolve(__dirname, "..", ARCHIVO);
  if (!fs.existsSync(ruta)) { console.error(`No existe el archivo ${ruta}`); process.exit(1); }
  const texto = fs.readFileSync(ruta, "utf8");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  IMPORTAR MAPEO RAP↔EVIDENCIA — ${path.basename(ruta)}`);
  console.log(`  ${DRY_RUN ? "⚠ DRY RUN — no se escribe en DB" : "Aplicando a DB"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mapeos    = parsearMapeos(texto);
  const criterios = parsearCriterios(texto);
  console.log(`Parseados: ${mapeos.length} mapeos evidencia→RAP, ${criterios.size} bloques de criterios.\n`);

  // Cache: todas las evidencias (id + nombre normalizado) y RAPs por código.
  const evidenciasDB = await prisma.evidencia.findMany({ select: { id: true, nombre: true } });
  const evNorm = evidenciasDB.map(e => ({ id: e.id, n: norm(e.nombre) }));
  const rapsDB = await prisma.rAP.findMany({ select: { id: true, codigo: true } });
  const rapPorCodigo = new Map(rapsDB.map(r => [r.codigo, r.id]));

  // ── 1. Vínculos RapEvidenciaRel ─────────────────────────────────────────────
  let creados = 0, sinEvidencia = 0, sinRap = 0;
  const noEncontradas = [];
  for (const m of mapeos) {
    const rapId = rapPorCodigo.get(m.rapCodigo);
    if (!rapId) { sinRap++; console.log(`  ⚠ RAP ${m.rapCodigo} no existe en DB`); continue; }

    const matches = evNorm.filter(e => e.n.includes(m.codigoEvidencia));
    if (matches.length === 0) { sinEvidencia++; noEncontradas.push(m.codigoEvidencia); continue; }

    for (const ev of matches) {
      if (!DRY_RUN) {
        await prisma.rapEvidenciaRel.upsert({
          where:  { rapId_evidenciaId: { rapId, evidenciaId: ev.id } },
          create: { rapId, evidenciaId: ev.id },
          update: {},
        });
      }
      creados++;
    }
  }

  console.log(`\n── Vínculos ──`);
  console.log(`  ✔ RapEvidenciaRel ${DRY_RUN ? "a crear" : "creados"}: ${creados} (sobre ${mapeos.length} mapeos; 1 código puede tocar varias fichas)`);
  if (sinEvidencia) console.log(`  ⚠ ${sinEvidencia} códigos sin evidencia en DB: ${noEncontradas.join(", ")}`);
  if (sinRap)       console.log(`  ⚠ ${sinRap} mapeos con RAP inexistente`);

  // ── 2. Criterios ────────────────────────────────────────────────────────────
  if (!NO_CRITERIOS) {
    let critOk = 0, critSinRap = 0;
    for (const [rapCodigo, texto] of criterios.entries()) {
      const rapId = rapPorCodigo.get(rapCodigo);
      if (!rapId) { critSinRap++; continue; }
      if (!DRY_RUN) {
        // Idempotente: reemplazar los criterios de ese RAP por el texto importado.
        await prisma.criterio.deleteMany({ where: { rapId } });
        await prisma.criterio.create({ data: { rapId, descripcion: texto, orden: 0 } });
      }
      critOk++;
    }
    console.log(`\n── Criterios ──`);
    console.log(`  ✔ RAPs con criterios ${DRY_RUN ? "a poblar" : "poblados"}: ${critOk}`);
    if (critSinRap) console.log(`  ⚠ ${critSinRap} bloques de criterios con RAP inexistente`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "  DRY RUN — vuelve a correr sin --dry-run para aplicar." : "  ✅ Importación aplicada.");
  console.log("═══════════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(async e => { console.error("❌ Error:", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
