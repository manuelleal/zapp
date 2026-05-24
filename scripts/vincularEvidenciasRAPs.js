/**
 * Vincula evidencias de la DB a sus RAPs en la tabla RapEvidenciaRel.
 *
 * Para la competencia de inglés (240202501), la regla GA{N} → RAP-0{N} es
 * unívoca y se puede aplicar automáticamente. Se crean los registros en
 * RapEvidenciaRel sin intervención del instructor.
 *
 * Para las demás competencias (transversales), el número de guía NO implica
 * el RAP: se imprime el listado de evidencias pendientes y se indica usar el
 * módulo de Matching IA desde la interfaz del instructor.
 *
 * Uso:
 *   node scripts/vincularEvidenciasRAPs.js [--dry-run] [--competencia=XXXXXXXXX] [--fichaId=<cuid>]
 *
 *   --dry-run               Muestra qué se haría sin escribir en DB.
 *   --competencia=240202501 Procesa solo esa competencia.
 *   --fichaId=<cuid>        Limita la búsqueda a una ficha específica.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const DRY_RUN      = process.argv.includes("--dry-run");
const COMP_FILTER  = (process.argv.find(a => a.startsWith("--competencia=")) ?? "").slice("--competencia=".length) || null;
const FICHA_FILTER = (process.argv.find(a => a.startsWith("--fichaId="))     ?? "").slice("--fichaId=".length)     || null;

// Solo estas competencias admiten la inferencia automática GA{N} → RAP-0{N}.
// Añadir aquí solo cuando la secuencia sea estrictamente lineal y verificada.
const COMPETENCIAS_AUTO = new Set(["240202501"]);

function log(...args) { console.log(new Date().toISOString(), ...args); }

// Extrae gaNum y competenciaCodigo del nombre de una evidencia Moodle.
// Patrón: "GA1-240202501-AA1-EV01" o "GA01-240202501-AA2 Descripción"
function parsearNombre(nombre) {
  const m = nombre.match(/\bGA(\d+)-(\d{9})\b/);
  if (!m) return null;
  return { gaNum: parseInt(m[1], 10), competenciaCodigo: m[2] };
}

async function main() {
  log(DRY_RUN ? "⚠ DRY RUN — no se escribe en DB" : "Vinculando evidencias → RAPs...");
  if (COMP_FILTER)  log(`  Filtro competencia : ${COMP_FILTER}`);
  if (FICHA_FILTER) log(`  Filtro fichaId     : ${FICHA_FILTER}`);

  // ── 1. Cargar evidencias con patrón GA{N}-{competencia} ──────────────────────
  const whereEv = {};
  if (FICHA_FILTER) whereEv.fichaId = FICHA_FILTER;

  const evidenciasDB = await prisma.evidencia.findMany({
    where:  whereEv,
    select: {
      id:      true,
      nombre:  true,
      fichaId: true,
      ficha:   { select: { codigo: true } },
    },
  });

  const evidenciasParsadas = evidenciasDB
    .map(ev => { const p = parsearNombre(ev.nombre); return p ? { ...ev, ...p } : null; })
    .filter(Boolean);

  if (evidenciasParsadas.length === 0) {
    console.log("⚠ No se encontraron evidencias con patrón GA{N}-{9dígitos} en la DB.");
    await prisma.$disconnect();
    return;
  }

  // Agrupar por competencia y aplicar filtro opcional
  const porCompetencia = new Map();
  for (const ev of evidenciasParsadas) {
    if (COMP_FILTER && ev.competenciaCodigo !== COMP_FILTER) continue;
    if (!porCompetencia.has(ev.competenciaCodigo)) porCompetencia.set(ev.competenciaCodigo, []);
    porCompetencia.get(ev.competenciaCodigo).push(ev);
  }

  if (porCompetencia.size === 0) {
    console.log(`⚠ Sin evidencias${COMP_FILTER ? ` para la competencia ${COMP_FILTER}` : ""}.`);
    await prisma.$disconnect();
    return;
  }

  // ── 2. Cargar competencias y sus RAPs desde la DB ────────────────────────────
  const codigosInvolucrados = [...porCompetencia.keys()];
  const competenciasDB = await prisma.competencia.findMany({
    where:   { codigo: { in: codigosInvolucrados } },
    include: { raps: { select: { id: true, codigo: true } } },
  });
  const competenciaMap = new Map(competenciasDB.map(c => [c.codigo, c]));

  let totalVinculadas = 0;
  let totalPendientesIA = 0;

  console.log("\n═══════════════════════════════════════════════════════════════════");

  for (const [compCodigo, evidencias] of porCompetencia.entries()) {
    const compDB = competenciaMap.get(compCodigo);

    console.log(`\n▸ COMPETENCIA ${compCodigo}  (${evidencias.length} evidencias)`);

    if (!compDB) {
      console.log(`  ⚠ No existe en DB — ejecuta primero: node scripts/extraerTodasLasGuias.js <guia.pdf>`);
      totalPendientesIA += evidencias.length;
      continue;
    }
    if (compDB.raps.length === 0) {
      console.log(`  ⚠ Existe en DB pero sin RAPs — ejecuta primero: node scripts/extraerTodasLasGuias.js <guia.pdf>`);
      totalPendientesIA += evidencias.length;
      continue;
    }

    console.log(`  RAPs disponibles: ${compDB.raps.map(r => r.codigo).join(", ")}`);

    if (COMPETENCIAS_AUTO.has(compCodigo)) {
      // ── Modo automático: GA{N} → RAP con sufijo N ──────────────────────────
      console.log(`  Modo: AUTOMÁTICO (inglés — GA{N} = RAP-0{N})`);

      // sufijo numérico (entero) → rapId
      const rapPorSufijo = new Map();
      for (const rap of compDB.raps) {
        const m = rap.codigo.match(/-0*(\d+)$/);
        if (m) rapPorSufijo.set(parseInt(m[1], 10), rap);
      }

      for (const ev of evidencias) {
        const rap = rapPorSufijo.get(ev.gaNum);
        if (!rap) {
          console.log(`  ⚠ GA${ev.gaNum} → no hay RAP con sufijo ${ev.gaNum} en DB (evidencia: "${ev.nombre.substring(0, 50)}")`);
          totalPendientesIA++;
          continue;
        }

        const fichaLabel = ev.ficha?.codigo ?? ev.fichaId;
        console.log(`  ✔ [Ficha ${fichaLabel}] "${ev.nombre.substring(0, 50)}" → ${rap.codigo}`);

        if (!DRY_RUN) {
          await prisma.rapEvidenciaRel.upsert({
            where:  { rapId_evidenciaId: { rapId: rap.id, evidenciaId: ev.id } },
            create: { rapId: rap.id, evidenciaId: ev.id },
            update: {},
          });
        }
        totalVinculadas++;
      }

    } else {
      // ── Modo listado: no se puede inferir sin riesgo de error ──────────────
      console.log(`  Modo: SOLO LISTADO — la vinculación GA{N}=RAP-0{N} NO aplica aquí.`);
      console.log(`  ℹ Para vincular estas evidencias, usa el módulo de Matching IA:`);
      console.log(`    Dashboard → Ficha → Evidencias → "Sugerir RAPs con IA"`);
      console.log(`  Evidencias pendientes de vincular:`);

      for (const ev of evidencias) {
        const fichaLabel = ev.ficha?.codigo ?? ev.fichaId;
        console.log(`    [Ficha ${fichaLabel}] GA${ev.gaNum} → "${ev.nombre.substring(0, 60)}"`);
      }
      totalPendientesIA += evidencias.length;
    }
  }

  // ── Resumen final ─────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log(`\n  Vinculadas en RapEvidenciaRel : ${totalVinculadas}${DRY_RUN ? " (dry-run — no escritas)" : ""}`);
  console.log(`  Pendientes de Matching IA     : ${totalPendientesIA}`);
  if (totalPendientesIA > 0) {
    console.log(`\n  ℹ Las ${totalPendientesIA} evidencias pendientes se pueden vincular desde la`);
    console.log(`    interfaz del instructor usando el módulo de Matching IA.`);
  }
  console.log();

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
