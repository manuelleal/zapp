/**
 * api/src/routes/admin.js — Panel de administración del DUEÑO de la app (superadmin).
 *
 * Solo accesible a usuarios con rol="superadmin" (el que licencia/opera la app). Sirve
 * para ver las métricas de la plataforma y gestionar a los instructores registrados.
 *
 * Rutas (todas exigen superadmin):
 *   GET    /api/admin/metricas            → agregados globales (incl. consumo de tokens IA)
 *   GET    /api/admin/instructores        → lista de instructores + métricas por c/u (tokens, último acceso)
 *   GET    /api/admin/instructores/:id    → detalle de un instructor + sus fichas
 *   PATCH  /api/admin/instructores/:id    → suspender / reactivar (soft-state)
 *   POST   /api/admin/administradores     → crear cuenta solo-admin (sin creds Zajuna)
 *   POST   /api/admin/instructores/:id/reset-password → contraseña temporal nueva
 *   DELETE /api/admin/instructores/:id    → eliminar instructor + todo su árbol
 *
 * Multi-tenant: este es el ÚNICO módulo que cruza datos de varios usuarios — por eso
 * está blindado tras `exigirSuperadmin` (lee el rol desde DB en cada request, así un
 * cambio de rol/suspensión surte efecto al instante).
 */

const bcrypt = require("bcrypt");
const crypto = require("crypto");
const prisma = require("../db/client");
const { encrypt } = require("../lib/crypto");
const { borrarUsuarioCompleto } = require("../lib/borrarUsuario");
const { esSuperadmin } = require("../lib/roles");

// Genera una contraseña temporal legible para el reset administrado. Se omiten
// caracteres ambiguos (O/0, I/l/1) para que el instructor pueda teclearla sin
// confundirse cuando el admin se la dicte por chat/teléfono.
function generarPasswordTemporal() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alfabeto[bytes[i] % alfabeto.length];
  return out;
}

// ─── Guard: solo superadmin ─────────────────────────────────────────────────────
async function exigirSuperadmin(req, reply) {
  // Lee rol+email FRESCO de la DB (un cambio de rol/suspensión surte efecto al instante).
  // esSuperadmin acepta el rol de la DB O el fallback por SUPERADMIN_EMAIL, así el dueño
  // nunca queda bloqueado aunque la DB se haya recreado y su rol vuelva al default.
  const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { rol: true, email: true } });
  if (!esSuperadmin(u)) {
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
      instructores, suspendidos, pendientes, fichas, evidencias, entregas, aprendices,
      actas, mensajes, mensajesPorEstado, jobs30d, scans30d,
      aiTotal, ai30d, aiPorProveedor,
    ] = await Promise.all([
      prisma.user.count({ where: { rol: "instructor" } }),
      prisma.user.count({ where: { rol: "instructor", suspendedAt: { not: null } } }),
      // Pendientes de aprobación (registro cerrado): instructores que aún no pueden entrar.
      prisma.user.count({ where: { rol: "instructor", aprobadoAt: null } }),
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
      // Consumo de tokens de IA: total histórico, últimos 30 días y desglose por proveedor.
      prisma.aiUsage.aggregate({ _sum: { totalTokens: true } }),
      prisma.aiUsage.aggregate({ where: { createdAt: { gte: hace30d } }, _sum: { totalTokens: true } }),
      prisma.aiUsage.groupBy({ by: ["provider"], _sum: { totalTokens: true } }),
    ]);

    // Normaliza el desglose de mensajes a un objeto { enviado, parcial, error, ... }.
    const mensajesEstados = {};
    for (const m of mensajesPorEstado) mensajesEstados[m.estado] = m._count;

    // Desglose de tokens por proveedor → { openrouter: N, anthropic: N, ... }.
    const iaPorProveedor = {};
    for (const p of aiPorProveedor) iaPorProveedor[p.provider] = p._sum.totalTokens || 0;

    return {
      instructores: { total: instructores, suspendidos, activos: instructores - suspendidos, pendientes },
      fichas, evidencias, entregas, aprendices, actas,
      mensajes: { total: mensajes, porEstado: mensajesEstados },
      actividad30d: { jobs: jobs30d, scans: scans30d },
      ia: {
        tokensTotal: aiTotal._sum.totalTokens || 0,
        tokens30d:   ai30d._sum.totalTokens || 0,
        porProveedor: iaPorProveedor,
      },
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
        createdAt: true, lastAutoScanAt: true, lastLoginAt: true, suspendedAt: true, aceptoTerminosAt: true, aprobadoAt: true,
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

    // Tokens de IA por usuario (1 sola query agrupada → sin N+1).
    const tokensAgrup = await prisma.aiUsage.groupBy({ by: ["userId"], _sum: { totalTokens: true } });
    const tkPorUser = new Map(tokensAgrup.map(t => [t.userId, t._sum.totalTokens || 0]));

    const instructores = users.map(u => ({
      id: u.id, nombre: u.nombre, email: u.email, rol: u.rol,
      competencia: u.competenciaNombre || u.competenciaCodigo || "—",
      createdAt: u.createdAt, lastAutoScanAt: u.lastAutoScanAt, lastLoginAt: u.lastLoginAt,
      suspendido: u.suspendedAt != null,
      aprobado: u.aprobadoAt != null,
      aceptoTerminos: u.aceptoTerminosAt != null,
      fichas: u._count.fichas, actas: u._count.actas, mensajes: u._count.mensajesFormativos,
      evidencias: evPorUser.get(u.id) || 0,
      aprendices: apPorUser.get(u.id) || 0,
      tokens: tkPorUser.get(u.id) || 0,
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

    const { suspender, aprobar } = req.body || {};
    const objetivo = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, rol: true } });
    if (!objetivo) return reply.code(404).send({ error: "Instructor no encontrado." });

    const data = {};
    if (typeof suspender === "boolean") {
      if (objetivo.rol === "superadmin") return reply.code(403).send({ error: "No se puede suspender a un administrador." });
      data.suspendedAt = suspender ? new Date() : null;
    }
    if (typeof aprobar === "boolean") {
      // Aprobar/revocar el acceso (registro cerrado). aprobadoAt null = pendiente.
      data.aprobadoAt = aprobar ? new Date() : null;
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: "Nada que actualizar (envía 'suspender' o 'aprobar')." });
    }

    const updated = await prisma.user.update({
      where:  { id: req.params.id },
      data,
      select: { id: true, suspendedAt: true, aprobadoAt: true },
    });
    return { id: updated.id, suspendido: updated.suspendedAt != null, aprobado: updated.aprobadoAt != null };
  });

  // ── POST /api/admin/administradores ────────────────────────────────────────
  // Crea una cuenta SOLO-ADMIN (rol superadmin) para un dueño/auditor que NO da
  // clase: por eso no exige credenciales de Zajuna ni competencia (se guardan
  // vacías cifradas para cumplir el schema). Útil para entrar al panel sin tener
  // que registrarse como instructor.
  fastify.post("/api/admin/administradores", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const { nombre, email, password } = req.body || {};
    if (!nombre || !email || !password) return reply.code(400).send({ error: "Nombre, email y contraseña son obligatorios." });
    if (String(password).length < 6)    return reply.code(400).send({ error: "La contraseña debe tener al menos 6 caracteres." });

    const existe = await prisma.user.findUnique({ where: { email } });
    if (existe) return reply.code(409).send({ error: "El email ya está registrado." });

    const passwordHash = await bcrypt.hash(password, 13);
    const admin = await prisma.user.create({
      data: {
        nombre, email, passwordHash,
        rol: "superadmin",
        zajunaUserEnc: encrypt(""), zajunaPassEnc: encrypt(""),
        competenciaCodigo: "", competenciaNombre: "Administrador",
      },
      select: { id: true, nombre: true, email: true, rol: true },
    });

    req.log.info(`Superadmin creó la cuenta de administrador ${email}`);
    return reply.code(201).send({ ok: true, admin });
  });

  // ── POST /api/admin/instructores/:id/reset-password ────────────────────────
  // Restablece la contraseña de un instructor. Como aún NO hay autoservicio por
  // email (no existe un SMTP global de la app, el de cada instructor es suyo), el
  // dueño genera aquí una contraseña TEMPORAL aleatoria: se guarda hasheada y se
  // devuelve en claro UNA sola vez para que el admin se la entregue al instructor.
  // No se puede resetear a OTRO superadmin.
  fastify.post("/api/admin/instructores/:id/reset-password", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!(await exigirSuperadmin(req, reply))) return;

    const objetivo = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, rol: true, nombre: true, email: true },
    });
    if (!objetivo) return reply.code(404).send({ error: "Instructor no encontrado." });
    if (objetivo.rol === "superadmin" && objetivo.id !== req.user.id) {
      return reply.code(403).send({ error: "No se puede restablecer la contraseña de otro administrador." });
    }

    const tempPassword = generarPasswordTemporal();
    const passwordHash = await bcrypt.hash(tempPassword, 13); // mismo coste que el registro
    await prisma.user.update({ where: { id: objetivo.id }, data: { passwordHash } });

    req.log.info(`Contraseña de ${objetivo.email} restablecida por superadmin`);
    return { ok: true, tempPassword, email: objetivo.email, nombre: objetivo.nombre };
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
