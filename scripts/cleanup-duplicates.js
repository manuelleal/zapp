/**
 * cleanup-duplicates.js
 *
 * Consolida Evidencias duplicadas dentro de una misma ficha que comparten
 * el mismo `nombre` pero quedaron con `href` distintos (bug histórico:
 * el worker viejo guardaba "?id=NNN&action=view" — el normalizarHref()
 * actual solo deja "?id=NNN", pero el constraint @@unique([fichaId, href])
 * dejó huérfanas las viejas).
 *
 * Estrategia de elección de ganadora (por grupo de duplicados):
 *   1) Href limpio (solo ?id=NNN sin params extra) gana
 *   2) Mayor cantidad de Entregas gana
 *   3) Id más viejo (cuid ordenado por tiempo) gana
 *
 * Migración FK antes de borrar la duplicada (NO se pierden datos):
 *   - Entrega: respeta @@unique([evidenciaId, aprendizId]); si colisiona,
 *     mergea (historial + aiFeedback al ganador, borra entrega dup).
 *   - EvidenciaConfig / ConfigAudit: repointan al ganador (sin unique).
 *   - RapEvidenciaRel: @@unique([rapId, evidenciaId]); colisión → borra dup.
 *   - MatchingPropuesta: @@unique([userId, evidenciaId, rapId]); colisión → borra dup.
 *
 * Uso:
 *   node scripts/cleanup-duplicates.js --dry-run    # diagnóstico, no toca DB
 *   node scripts/cleanup-duplicates.js              # ejecuta los borrados
 *   node scripts/cleanup-duplicates.js --ficha=ID   # solo una ficha específica
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const DRY_RUN = process.argv.includes("--dry-run");
const fichaArg = process.argv.find(a => a.startsWith("--ficha="));
const FICHA_ID = fichaArg ? fichaArg.split("=")[1] : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Href "limpio" = url con un solo query param (id). Cualquier &action=, &mode=, etc.
// lo marca como sucio.
function isHrefLimpio(href) {
  try {
    const url = new URL(href);
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && keys[0] === "id";
  } catch {
    return false;
  }
}

function normalizarHref(href) {
  try {
    const url = new URL(href);
    const id = url.searchParams.get("id");
    if (id) return `${url.origin}${url.pathname}?id=${id}`;
  } catch {}
  return href;
}

async function elegirGanadora(evidencias) {
  const evaluadas = await Promise.all(evidencias.map(async (ev) => {
    const entregas = await prisma.entrega.count({ where: { evidenciaId: ev.id } });
    return {
      ev,
      entregas,
      limpio: isHrefLimpio(ev.href) ? 1 : 0,
    };
  }));

  evaluadas.sort((a, b) => {
    if (a.limpio   !== b.limpio)   return b.limpio   - a.limpio;    // limpio primero
    if (a.entregas !== b.entregas) return b.entregas - a.entregas;  // más entregas primero
    return a.ev.id.localeCompare(b.ev.id);                          // id más viejo (cuid)
  });

  return { ganadora: evaluadas[0].ev, evaluadas };
}

// ─── Consolidación ──────────────────────────────────────────────────────────

async function consolidar(dup, winner) {
  const acciones = {
    entregasMovidas: 0,
    entregasMergeadas: 0,
    configsMovidos: 0,
    auditsMovidos: 0,
    rapRelsMovidas: 0,
    rapRelsDuplicadas: 0,
    matchingsMovidos: 0,
    matchingsDuplicados: 0,
  };

  // 1) Entregas — respetar @@unique([evidenciaId, aprendizId])
  const entregasDup = await prisma.entrega.findMany({ where: { evidenciaId: dup.id } });
  for (const e of entregasDup) {
    const existe = await prisma.entrega.findUnique({
      where: { evidenciaId_aprendizId: { evidenciaId: winner.id, aprendizId: e.aprendizId } },
    });
    if (existe) {
      // Winner ya tiene entrega para este aprendiz → merge: mover historial + aiFeedback.
      await prisma.historialEstado.updateMany({
        where: { entregaId: e.id },
        data:  { entregaId: existe.id },
      });
      await prisma.aIFeedback.updateMany({
        where: { entregaId: e.id },
        data:  { entregaId: existe.id },
      });
      const update = {};
      if (existe.notaActual   == null && e.notaActual   != null) update.notaActual   = e.notaActual;
      if (existe.moodlePostId == null && e.moodlePostId != null) update.moodlePostId = e.moodlePostId;
      if (Object.keys(update).length > 0) {
        await prisma.entrega.update({ where: { id: existe.id }, data: update });
      }
      await prisma.entrega.delete({ where: { id: e.id } });
      acciones.entregasMergeadas++;
    } else {
      await prisma.entrega.update({ where: { id: e.id }, data: { evidenciaId: winner.id } });
      acciones.entregasMovidas++;
    }
  }

  // 2) EvidenciaConfig — sin unique
  const ecs = await prisma.evidenciaConfig.updateMany({
    where: { evidenciaId: dup.id },
    data:  { evidenciaId: winner.id },
  });
  acciones.configsMovidos = ecs.count;

  // 3) ConfigAudit — sin unique
  const cas = await prisma.configAudit.updateMany({
    where: { evidenciaId: dup.id },
    data:  { evidenciaId: winner.id },
  });
  acciones.auditsMovidos = cas.count;

  // 4) RapEvidenciaRel — @@unique([rapId, evidenciaId])
  const rels = await prisma.rapEvidenciaRel.findMany({ where: { evidenciaId: dup.id } });
  for (const r of rels) {
    const existe = await prisma.rapEvidenciaRel.findUnique({
      where: { rapId_evidenciaId: { rapId: r.rapId, evidenciaId: winner.id } },
    });
    if (existe) {
      await prisma.rapEvidenciaRel.delete({ where: { id: r.id } });
      acciones.rapRelsDuplicadas++;
    } else {
      await prisma.rapEvidenciaRel.update({ where: { id: r.id }, data: { evidenciaId: winner.id } });
      acciones.rapRelsMovidas++;
    }
  }

  // 5) MatchingPropuesta — @@unique([userId, evidenciaId, rapId])
  const props = await prisma.matchingPropuesta.findMany({ where: { evidenciaId: dup.id } });
  for (const p of props) {
    const existe = await prisma.matchingPropuesta.findUnique({
      where: { userId_evidenciaId_rapId: { userId: p.userId, evidenciaId: winner.id, rapId: p.rapId } },
    });
    if (existe) {
      await prisma.matchingPropuesta.delete({ where: { id: p.id } });
      acciones.matchingsDuplicados++;
    } else {
      await prisma.matchingPropuesta.update({ where: { id: p.id }, data: { evidenciaId: winner.id } });
      acciones.matchingsMovidos++;
    }
  }

  // 6) Borrar la duplicada
  await prisma.evidencia.delete({ where: { id: dup.id } });

  return acciones;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Cleanup de Evidencias duplicadas (mismo nombre + fichaId)");
  if (DRY_RUN)  console.log("  MODO DRY-RUN — no se borra nada de la DB");
  if (FICHA_ID) console.log(`  FILTRO ficha: ${FICHA_ID}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const where = FICHA_ID ? { fichaId: FICHA_ID } : {};
  const evidencias = await prisma.evidencia.findMany({
    where,
    select: { id: true, fichaId: true, nombre: true, href: true },
    orderBy: { id: "asc" },
  });

  // Agrupar por (fichaId, nombre)
  const grupos = new Map();
  for (const ev of evidencias) {
    const key = `${ev.fichaId}|${ev.nombre}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(ev);
  }

  const duplicados = [...grupos.values()].filter(g => g.length > 1);
  console.log(`Evidencias totales escaneadas : ${evidencias.length}`);
  console.log(`Grupos con duplicados         : ${duplicados.length}`);
  console.log(`Evidencias a borrar (estimado): ${duplicados.reduce((s, g) => s + g.length - 1, 0)}\n`);

  if (duplicados.length === 0) {
    console.log("✅ No hay duplicados. Nada que hacer.");
    await prisma.$disconnect();
    return;
  }

  let totalBorradas = 0;
  let normalizadasGanadoras = 0;
  const errores = [];

  for (const grupo of duplicados) {
    const { ganadora, evaluadas } = await elegirGanadora(grupo);
    const perdedoras = grupo.filter(ev => ev.id !== ganadora.id);

    console.log(`\n[ficha ${ganadora.fichaId}] "${ganadora.nombre.substring(0, 60)}"`);
    for (const e of evaluadas) {
      const marca = e.ev.id === ganadora.id ? "✓ GANADORA" : "✗ a borrar";
      console.log(`  ${marca}  id=${e.ev.id.substring(0, 10)}…  limpio=${e.limpio}  entregas=${e.entregas}  href=${e.ev.href.substring(0, 80)}`);
    }

    if (DRY_RUN) continue;

    try {
      for (const dup of perdedoras) {
        const acc = await consolidar(dup, ganadora);
        totalBorradas++;
        const movidas = Object.entries(acc)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        if (movidas) console.log(`    → ${movidas}`);
      }

      // Re-normalizar el href del ganador si todavía está sucio
      const limpio = normalizarHref(ganadora.href);
      if (limpio !== ganadora.href) {
        try {
          await prisma.evidencia.update({ where: { id: ganadora.id }, data: { href: limpio } });
          console.log(`    ✓ href ganador normalizado → ${limpio}`);
          normalizadasGanadoras++;
        } catch (e) {
          console.log(`    ⚠  no se pudo normalizar href del ganador: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`    ❌ ERROR consolidando: ${e.message}`);
      errores.push({ ficha: ganadora.fichaId, nombre: ganadora.nombre, error: e.message });
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESUMEN");
  console.log(`  Evidencias eliminadas       : ${totalBorradas}`);
  console.log(`  Hrefs ganadores normalizados: ${normalizadasGanadoras}`);
  if (errores.length > 0) {
    console.log(`  ❌ Errores (${errores.length}):`);
    errores.forEach(e => console.log(`    - [${e.ficha}] ${e.nombre}: ${e.error}`));
  }
  if (DRY_RUN) console.log("\n  (DRY-RUN — corre sin --dry-run para aplicar)");
  console.log("═══════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(e => {
  console.error("Error fatal:", e);
  prisma.$disconnect().finally(() => process.exit(1));
});
