/**
 * mensajesProgramadosWorker.js — Cola "mensajesProgramados" (tick cada 10 min,
 * ver lib/queue.js).
 *
 * QUÉ HACE: busca los MensajeProgramado VENCIDOS (pausadoAt null y
 * proximaEjecucion <= now), y por cada uno:
 *   1. Lo "reclama" re-agendando proximaEjecucion ANTES de enviar, con un
 *      updateMany condicionado al valor previo (optimistic lock). Si otro tick
 *      lo reclamó primero, count=0 y se salta — eso es la idempotencia: aunque
 *      el tick corra dos veces, cada corrida dispara UNA sola vez.
 *   2. Recalcula los destinatarios EN ESTE MOMENTO (no los de cuando se
 *      programó): aprendices válidos de la ficha + filtro guardado
 *      (todos / con_pendientes / con_desaprobadas / inactivos / nunca),
 *      con las evidencias del alcance guardado (competencia / todas / ids).
 *   3. Crea un MensajeFormativo normal (queda en el historial — log de cada
 *      corrida) y encola el envío en la cola del canal (email / zajuna).
 *
 * Si NINGÚN aprendiz cumple el filtro hoy, NO crea mensaje (no spamea el
 * historial con corridas vacías) — solo re-agenda y loguea.
 *
 * NO lanza browser: delega el envío real en emailMasivoWorker /
 * mensajeFormativoWorker. job.data: {} (el tick no necesita datos).
 * concurrency: 1 (refuerza la idempotencia del claim).
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const prisma = require("../db/client");
const { filtrarAprendicesValidos } = require("../lib/aprendices");
const { resumenEvidenciasPorAprendiz, aplanarEvidenciasToken, crearYEncolarEnvio } = require("../lib/mensajesMasivos");

const log = (msg) => console.log(`[mensajesProgramados] ${msg}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Días sin acceso; null = nunca ha entrado. */
function diasSinAcceso(ultimoAcceso) {
  if (!ultimoAcceso) return null;
  return Math.floor((Date.now() - new Date(ultimoAcceso).getTime()) / 86_400_000);
}

/**
 * Re-agenda: siguiente ocurrencia de `hora` al menos `intervaloDias` días
 * después de la corrida actual (y siempre en el futuro, por si el proceso
 * estuvo caído varios días — no dispara N corridas atrasadas de golpe).
 */
function siguienteEjecucion(prevProxima, intervaloDias, hora) {
  const [h, m] = hora.split(":").map(Number);
  const next = new Date(prevProxima);
  next.setDate(next.getDate() + intervaloDias);
  next.setHours(h, m, 0, 0);
  const ahora = new Date();
  while (next <= ahora) next.setDate(next.getDate() + intervaloDias);
  return next;
}

/** Aplica el filtro de destinatarios guardado sobre los aprendices de la ficha. */
function pasaFiltro(filtro, aprendiz, resumenAprendiz) {
  switch (filtro) {
    case "con_pendientes":   return (resumenAprendiz?.pendientes.length ?? 0) > 0;
    case "con_desaprobadas": return (resumenAprendiz?.desaprobadas.length ?? 0) > 0;
    case "inactivos": { const d = diasSinAcceso(aprendiz.ultimoAcceso); return d === null || d > 7; }
    case "nunca":            return aprendiz.ultimoAcceso === null;
    case "todos":
    default:                 return true;
  }
}

// ─── Corrida de un programado ────────────────────────────────────────────────

async function ejecutarProgramado(prog) {
  const user = await prisma.user.findUnique({
    where:  { id: prog.userId },
    select: { nombre: true, competenciaCodigo: true },
  });
  const ficha = await prisma.ficha.findUnique({ where: { id: prog.fichaId } });
  if (!user || !ficha || ficha.archivedAt) {
    log(`prog=${prog.id}: ficha archivada o usuario inexistente — skip`);
    return;
  }

  // Destinatarios de HOY (regla multi-tenant: todo cuelga de la ficha del user)
  const aprendicesRaw = await prisma.aprendiz.findMany({
    where:  { fichaId: prog.fichaId },
    select: { id: true, nombre: true, email: true, moodleId: true, ultimoAcceso: true },
    orderBy: { nombre: "asc" },
  });
  const aprendices = filtrarAprendicesValidos(aprendicesRaw);

  // Alcance de evidencias guardado → resumen pendientes/desaprobadas por aprendiz
  const alcance = prog.alcanceEvidencias || "competencia";
  const resumen = await resumenEvidenciasPorAprendiz({
    fichaId:           prog.fichaId,
    aprendizIds:       aprendices.map(a => a.id),
    evidenciaIds:      alcance === "ids" && Array.isArray(prog.evidenciaIds) ? prog.evidenciaIds : null,
    // "todas" → sin código: caen todas las activas de la ficha (líder de ficha)
    competenciaCodigo: alcance === "competencia" ? (user.competenciaCodigo || null) : null,
  });

  const destinatarios = aprendices
    .filter(a => pasaFiltro(prog.filtroDestinatarios, a, resumen.get(a.id)))
    .map(a => ({
      aprendizId: a.id,
      nombre:     a.nombre,
      email:      a.email,
      moodleId:   a.moodleId,
      evidencias: aplanarEvidenciasToken(resumen.get(a.id), prog.incluirDesaprobadas),
      ficha:      ficha.codigo,
      instructor: user.nombre,
    }))
    // El canal necesita su dato de contacto; sin él el envío falla por destinatario.
    .filter(d => (prog.canal === "email" ? d.email : d.moodleId));

  if (destinatarios.length === 0) {
    log(`prog=${prog.id} ficha=${ficha.codigo}: 0 destinatarios cumplen "${prog.filtroDestinatarios}" hoy — sin envío`);
    return;
  }

  const { mensaje, jobId } = await crearYEncolarEnvio({
    userId:        prog.userId,
    fichaId:       prog.fichaId,
    canal:         prog.canal,
    asunto:        prog.asunto,
    cuerpo:        prog.cuerpo,
    destinatarios,
    templateTipo:  prog.templateTipo,
  });
  log(`prog=${prog.id} ficha=${ficha.codigo}: enviado a ${destinatarios.length} (mensaje=${mensaje.id} job=${jobId})`);
}

// ─── Worker (tick) ───────────────────────────────────────────────────────────

const worker = new Worker("mensajesProgramados", async () => {
  const ahora = new Date();
  const vencidos = await prisma.mensajeProgramado.findMany({
    where: { pausadoAt: null, proximaEjecucion: { lte: ahora } },
  });
  if (vencidos.length === 0) return { corridos: 0 };

  let corridos = 0;
  for (const prog of vencidos) {
    // Claim idempotente (ver cabecera): re-agendar ANTES de enviar.
    const claim = await prisma.mensajeProgramado.updateMany({
      where: { id: prog.id, proximaEjecucion: prog.proximaEjecucion },
      data:  {
        proximaEjecucion: siguienteEjecucion(prog.proximaEjecucion, prog.intervaloDias, prog.hora),
        lastRunAt:        ahora,
      },
    });
    if (claim.count === 0) continue; // otro tick lo tomó

    try {
      await ejecutarProgramado(prog);
      corridos++;
    } catch (e) {
      // No re-throw: una corrida rota no debe frenar las demás. Ya quedó
      // re-agendada; el error queda en el log del worker.
      console.error(`[mensajesProgramados] prog=${prog.id} falló: ${e.message}`);
    }
  }
  return { corridos };
}, { connection, concurrency: 1 });

worker.on("failed", (job, err) => {
  console.error(`[mensajesProgramados] tick failed: ${err.message}`);
});

module.exports = worker;
