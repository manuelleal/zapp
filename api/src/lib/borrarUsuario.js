/**
 * borrarUsuario.js — Borra un instructor y TODO su árbol de datos en una transacción.
 *
 * El schema NO tiene onDelete cascade (a propósito: borrar un usuario es una acción
 * deliberada del superadmin, no algo que deba pasar por un FK). Por eso aquí se borra
 * en orden de dependencias (hojas → raíz). Lo usan:
 *   - DELETE /api/admin/instructores/:id  (panel de administración)
 *   - scripts de limpieza de datos de prueba
 *
 * NO filtra por nada externo: recibe el userId y borra todo lo suyo. El llamador es
 * responsable de la autorización (que sea superadmin).
 *
 * Devuelve un objeto { tabla: count } con lo borrado, para auditoría/log.
 */

async function borrarUsuarioCompleto(prisma, userId) {
  // fichaIds del usuario: muchas tablas cuelgan de la ficha, no del user directo.
  const fichas = await prisma.ficha.findMany({ where: { userId }, select: { id: true } });
  const fichaIds = fichas.map(f => f.id);

  const r = {};
  await prisma.$transaction(async (tx) => {
    // Hojas más profundas primero (historial/feedback de entregas).
    r.historial      = await tx.historialEstado.deleteMany({ where: { entrega: { evidencia: { fichaId: { in: fichaIds } } } } });
    r.aiFeedback     = await tx.aIFeedback.deleteMany({ where: { entrega: { evidencia: { fichaId: { in: fichaIds } } } } });
    r.entregas       = await tx.entrega.deleteMany({ where: { evidencia: { fichaId: { in: fichaIds } } } });
    // Participantes de actas: por acta del user y por aprendiz de sus fichas.
    r.actaPartActa   = await tx.actaParticipante.deleteMany({ where: { acta: { userId } } });
    r.actaPartAprend = await tx.actaParticipante.deleteMany({ where: { aprendiz: { fichaId: { in: fichaIds } } } });
    r.evidConfig     = await tx.evidenciaConfig.deleteMany({ where: { evidencia: { fichaId: { in: fichaIds } } } });
    r.configAudit    = await tx.configAudit.deleteMany({ where: { userId } });
    r.rapRel         = await tx.rapEvidenciaRel.deleteMany({ where: { evidencia: { fichaId: { in: fichaIds } } } });
    r.matching       = await tx.matchingPropuesta.deleteMany({ where: { userId } });
    r.configChange   = await tx.configChangeJob.deleteMany({ where: { userId } });
    // Mensajes antes que actas (FK actaId opcional) y antes que fichas.
    r.msgForm        = await tx.mensajeFormativo.deleteMany({ where: { userId } });
    r.actas          = await tx.actaSeguimiento.deleteMany({ where: { userId } });
    r.msgProg        = await tx.mensajeProgramado.deleteMany({ where: { userId } });
    r.evidencias     = await tx.evidencia.deleteMany({ where: { fichaId: { in: fichaIds } } });
    r.aprendices     = await tx.aprendiz.deleteMany({ where: { fichaId: { in: fichaIds } } });
    r.jobs           = await tx.job.deleteMany({ where: { userId } });
    r.configCorreo   = await tx.configCorreo.deleteMany({ where: { userId } });
    r.aiUsage        = await tx.aiUsage.deleteMany({ where: { userId } });
    r.fichas         = await tx.ficha.deleteMany({ where: { userId } });
    r.user           = await tx.user.delete({ where: { id: userId } });
  }, { timeout: 60000 });

  return r;
}

module.exports = { borrarUsuarioCompleto };
