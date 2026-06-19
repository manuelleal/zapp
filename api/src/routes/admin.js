/**
 * api/src/routes/admin.js — Panel de administración del DUEÑO de la app (superadmin).
 *
 * Solo accesible a usuarios con rol="superadmin" (el que licencia/opera la app). Sirve
 * para ver las métricas de la plataforma y gestionar a los instructores registrados.
 *
 * Rutas (todas exigen superadmin):
 *   GET    /api/admin/metricas            → agregados globales de la plataforma
 *   GET    /api/admin/instructores        → lista de instructores + métricas por c/u
 *   GET    /api/admin/instructores/:id    → detalle de un instructor + sus fichas
 *   PATCH  /api/admin/instructores/:id    → suspender / reactivar (soft-state)
 *   DELETE /api/admin/instructores/:id    → eliminar instructor + todo su árbol
 *
 * Multi-tenant: este es el ÚNICO módulo que cruza datos de varios usuarios — por eso
 * está blindado tras `exigirSuperadmin` (lee el rol desde DB en cada request, así un
 * cambio de rol/suspensión surte efecto al instante).
 */

const prisma = require("../db/client");
const { borrarUsuarioCompleto } = require("../lib/borrarUsuario");

// ─── Guard: solo superadmin ─────────────────────────────────────────────────────
async function exigirSuperadmin(req, reply) {
  const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { rol: true } });
  if (!u || u.rol !== "superadmin") {
    reply.code(403).send({ error: "Acceso restringido al administrador." });
    return false;
  }
  return true;
}

async function adminRoutes(fastify) {

  // ── GET /api/admin/metricas ────────────────────────────────────────────────
  fastify.get("/api/admin/metricas", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const hace30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      instructores, suspendidos, fichas, evidencias, entregas, aprendices,
      actas, mensajes, mensajesPorEstado, jobs30d, scans30d,
    ] = await Promise.all([
      prisma.user.count({ where: { rol: "instructor" } }),
      prisma.user.count({ where: { rol: "instructor", suspendedAt: { not: null } } }),
      prisma.ficha.count(),
      prisma.evidencia.count(),
      prisma.entrega.count(),
      prisma.aprendiz.count(),
      prisma.actaSeguimiento.count(),
      prisma.mensajeFormativo.count(),
      prisma.mensajeFormativo.groupBy({ by: ["estado"], _count: true }),
      prisma.job.count({ where: { creadoAt: { gte: hace30d } } }),
      // "Escaneos" = jobs que raspan Zajuna (evidencias + descubrir fichas).
      prisma.job.count({ where: { creadoAt: { gte: hace30d }, tipo: { in: ["evidencias", "fichas"] } } }),
    ]);

    // Normaliza el desglose de mensajes a un objeto { enviado, parcial, error, ... }.
    const mensajesEstados = {};
    for (const m of mensajesPorEstado) mensajesEstados[m.estado] = m._count;

    return {
      instructores: { total: instructores, suspendidos, activos: instructores - suspendidos },
      fichas, evidencias, entregas, aprendices, actas,
      mensajes: { total: mensajes, porEstado: mensajesEstados },
      actividad30d: { jobs: jobs30d, scans: scans30d },
    };
  });

  // ── GET /api/admin/instructores ────────────────────────────────────────────
  fastify.get("/api/admin/instructores", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, nombre: true, email: true, rol: true,
        competenciaNombre: true, competenciaCodigo: true,
        createdAt: true, lastAutoScanAt: true, suspendedAt: true, aceptoTerminosAt: true,
        _count: { select: { fichas: true, actas: true, mensajesFormativos: true } },
      },
    });

    // Evidencias por usuario: cuelgan de Ficha (no hay relación directa User→Evidencia),
    // así que se suman desde las fichas en una sola query (evita N+1).
    const fichasConteo = await prisma.ficha.findMany({
      select: { userId: true, _count: { select: { evidencias: true, aprendices: true } } },
    });
    const evPorUser = new Map();
    const apPorUser = new Map();
    for (const f of fichasConteo) {
      evPorUser.set(f.userId, (evPorUser.get(f.userId) || 0) + f._count.evidencias);
      apPorUser.set(f.userId, (apPorUser.get(f.userId) || 0) + f._count.aprendices);
    }

    const instructores = users.map(u => ({
      id: u.id, nombre: u.nombre, email: u.email, rol: u.rol,
      competencia: u.competenciaNombre || u.competenciaCodigo || "—",
      createdAt: u.createdAt, lastAutoScanAt: u.lastAutoScanAt,
      suspendido: u.suspendedAt != null,
      aceptoTerminos: u.aceptoTerminosAt != null,
      fichas: u._count.fichas, actas: u._count.actas, mensajes: u._count.mensajesFormativos,
      evidencias: evPorUser.get(u.id) || 0,
      aprendices: apPorUser.get(u.id) || 0,
    }));

    return { instructores };
  });

  // ── GET /api/admin/instructores/:id ────────────────────────────────────────
  fastify.get("/api/admin/instructores/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const u = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, nombre: true, email: true, rol: true,
        competenciaNombre: true, competenciaCodigo: true,
        createdAt: true, lastAutoScanAt: true, suspendedAt: true, aceptoTerminosAt: true,
        fichas: {
          select: { id: true, codigo: true, nombre: true, programa: true, createdAt: true,
                    _count: { select: { evidencias: true, aprendices: true, actas: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!u) return reply.code(404).send({ error: "Instructor no encontrado." });
    return { instructor: u };
  });

  // ── PATCH /api/admin/instructores/:id ──────────────────────────────────────
  // Body: { suspender: boolean }  → setea/limpia suspendedAt.
  fastify.patch("/api/admin/instructores/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const { suspender } = req.body || {};
    const objetivo = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, rol: true } });
    if (!objetivo) return reply.code(404).send({ error: "Instructor no encontrado." });
    if (objetivo.rol === "superadmin") return reply.code(403).send({ error: "No se puede suspender a un administrador." });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data:  { suspendedAt: suspender ? new Date() : null },
      select: { id: true, suspendedAt: true },
    });
    return { id: updated.id, suspendido: updated.suspendedAt != null };
  });

  // ── DELETE /api/admin/instructores/:id ─────────────────────────────────────
  // Elimina el instructor y TODO su árbol de datos (ver lib/borrarUsuario.js).
  fastify.delete("/api/admin/instructores/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const objetivo = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, rol: true } });
    if (!objetivo) return reply.code(404).send({ error: "Instructor no encontrado." });
    if (objetivo.rol === "superadmin") return reply.code(403).send({ error: "No se puede eliminar a un administrador." });
    if (objetivo.id === req.user.id)   return reply.code(403).send({ error: "No puedes eliminarte a ti mismo." });

    const borrado = await borrarUsuarioCompleto(prisma, req.params.id);
    req.log.info({ borrado }, `Instructor ${req.params.id} eliminado por superadmin`);
    return reply.code(200).send({ ok: true });
  });
}

module.exports = adminRoutes;
