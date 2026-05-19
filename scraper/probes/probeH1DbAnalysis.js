/**
 * scraper/probeH1DbAnalysis.js
 *
 * HIPÓTESIS 1 — Solo DB, sin browser.
 *
 * Los nombres de Evidencia ya en DB tienen la forma:
 *   GA1-220501092-AA1-EV01  (o variantes con guiones/espacios)
 *
 * Estructura del código:
 *   GA<guiaNum>  - <competenciaCodigo>  - AA<aaNum>  - EV<evNum>
 *   ──────────    ────────────────────    ──────────    ────────
 *   guía         9 dígitos = competencia  actividad =   evidencia
 *                (=programa+competencia)  RAP número
 *
 * Este script:
 *   1. Lee todas las Evidencias de la DB.
 *   2. Parsea cada nombre con la regex.
 *   3. Agrupa por (userId, fichaId, competenciaCodigo, aaNum).
 *   4. Imprime el plan de RAPs + RapEvidenciaRel que se crearían.
 *   5. NO escribe nada en la DB.
 *
 * Uso:
 *   node scraper/probeH1DbAnalysis.js
 *   node scraper/probeH1DbAnalysis.js --json   ← salida JSON pura
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const prisma = require("../api/src/db/client");

const GA_REGEX = /GA(\d+)-(\d{9})-AA(\d+)-EV(\d+)/i;

function parsearCodigo(nombre) {
  const m = (nombre || "").replace(/\s+/g, "").match(GA_REGEX);
  if (!m) return null;
  return {
    guiaNum:          parseInt(m[1], 10),
    competenciaCodigo: m[2],
    aaNum:            parseInt(m[3], 10),
    evNum:            parseInt(m[4], 10),
  };
}

async function main() {
  const modoJson = process.argv.includes("--json");

  const evidencias = await prisma.evidencia.findMany({
    select: {
      id:     true,
      nombre: true,
      ficha:  { select: { id: true, codigo: true, userId: true } },
    },
  });

  if (!modoJson) {
    console.error(`[H1] ${evidencias.length} evidencias leídas de la DB.`);
  }

  // ── Parsear y agrupar ────────────────────────────────────────────────────────

  // Map: "userId:fichaId:competenciaCodigo:aaNum" → { meta, evidenciaIds[] }
  const grupos = new Map();
  let sinParsear = 0;

  for (const ev of evidencias) {
    const parsed = parsearCodigo(ev.nombre);
    if (!parsed) {
      sinParsear++;
      continue;
    }

    const { guiaNum, competenciaCodigo, aaNum, evNum } = parsed;
    const key = `${ev.ficha.userId}:${ev.ficha.id}:${competenciaCodigo}:${aaNum}`;

    if (!grupos.has(key)) {
      grupos.set(key, {
        userId:           ev.ficha.userId,
        fichaId:          ev.ficha.id,
        fichaCodigo:      ev.ficha.codigo,
        competenciaCodigo,
        guiaNum,
        aaNum,
        rapCodigo:        `RAP${aaNum}`,
        descripcion:      `RAP ${aaNum} — GA${guiaNum}-${competenciaCodigo}-AA${aaNum}`,
        evidencias:       [],
      });
    }

    grupos.get(key).evidencias.push({ id: ev.id, nombre: ev.nombre, evNum });
  }

  // ── Construir reporte ────────────────────────────────────────────────────────

  const plan = Array.from(grupos.values()).sort((a, b) => {
    if (a.userId !== b.userId) return a.userId.localeCompare(b.userId);
    if (a.fichaCodigo !== b.fichaCodigo) return a.fichaCodigo.localeCompare(b.fichaCodigo);
    if (a.competenciaCodigo !== b.competenciaCodigo) return a.competenciaCodigo.localeCompare(b.competenciaCodigo);
    return a.aaNum - b.aaNum;
  });

  if (modoJson) {
    console.log(JSON.stringify({ plan, sinParsear }, null, 2));
    await prisma.$disconnect();
    return;
  }

  // ── Salida legible ───────────────────────────────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  HIPÓTESIS 1 — Análisis DB  (sin browser, sin escritura) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\n  Evidencias totales    : ${evidencias.length}`);
  console.log(`  Sin parsear (sin código GA): ${sinParsear}`);
  console.log(`  Grupos RAP detectados : ${plan.length}\n`);

  // Agrupar por ficha para la vista
  const porFicha = new Map();
  for (const g of plan) {
    const k = `${g.userId}|${g.fichaId}`;
    if (!porFicha.has(k)) porFicha.set(k, { fichaCodigo: g.fichaCodigo, userId: g.userId, raps: [] });
    porFicha.get(k).raps.push(g);
  }

  for (const [, ficha] of porFicha) {
    console.log(`  ── Ficha ${ficha.fichaCodigo}  (userId: ${ficha.userId.substring(0, 8)}…)`);
    for (const g of ficha.raps) {
      console.log(`     RAP${g.aaNum}  competencia=${g.competenciaCodigo}  guia=GA${g.guiaNum}`);
      console.log(`       descripcion placeholder: "${g.descripcion}"`);
      console.log(`       evidencias vinculadas  : ${g.evidencias.length}`);
      g.evidencias.forEach(e => console.log(`         EV${e.evNum}: ${e.nombre}`));
    }
    console.log();
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("  CONCLUSIÓN:");
  if (plan.length > 0) {
    console.log(`  ✅ Se pueden crear ${plan.length} RAP(s) y sus relaciones directamente desde la DB.`);
    console.log("  ✅ NO se necesita browser ni PDF para la estructura base.");
    console.log("  ⚠  Las descripciones quedarían como placeholder GA-AA.");
    console.log("  → Ejecuta probeH2GuiasIterator.js para enriquecer con descripciones del PDF.");
  } else {
    console.log("  ⚠  No se encontraron evidencias con código GA en la DB.");
    console.log("  → ¿Las evidencias tienen un nombre diferente? Revisando ejemplos:");
    evidencias.slice(0, 10).forEach(e => console.log(`     "${e.nombre}"`));
  }
  console.log("══════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
