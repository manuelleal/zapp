const prisma = require("../db/client");
const { resolverCompetenciaId } = require("../lib/competencia");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Obtiene la competenciaId del usuario autenticado.
 * Lanza 422 si el usuario no tiene competencia asignada.
 *
 * Resuelve por código estable y auto-sana el FK (ver lib/competencia.js): así, si
 * el instructor se registró antes de que se cargaran sus RAPs (competenciaId=null)
 * o las competencias se re-sembraron (cuid obsoleto), igual ve sus RAPs.
 */
async function getCompetenciaId(fastify, req, reply) {
  const competenciaId = await resolverCompetenciaId(req.user.id);
  if (!competenciaId) {
    reply.code(422).send({ error: "El usuario no tiene una competencia asignada." });
    return null;
  }
  return competenciaId;
}

/**
 * Verifica que un RAP pertenezca a la competencia del usuario.
 * Devuelve el RAP o envía 404/403.
 */
async function getRapParaUsuario(rapId, competenciaId, reply) {
  const rap = await prisma.rAP.findUnique({ where: { id: rapId } });
  if (!rap)                               { reply.code(404).send({ error: "RAP no encontrado." }); return null; }
  if (rap.competenciaId !== competenciaId){ reply.code(403).send({ error: "Sin acceso a este RAP." }); return null; }
  return rap;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

async function rapsRoutes(fastify) {

  // ── M5: Export ──────────────────────────────────────────────────────────────
  // GET /api/raps/export — exportar RAPs+criterios como JSON descargable
  // IMPORTANTE: esta ruta debe ir ANTES de /api/raps/:rapId para que "export"
  // no sea capturado como parámetro rapId.
  fastify.get("/api/raps/export", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const competencia = await prisma.competencia.findUnique({
      where: { id: competenciaId },
      select: { codigo: true },
    });

    const raps = await prisma.rAP.findMany({
      where:   { competenciaId },
      include: { criterios: { orderBy: { orden: "asc" } } },
      orderBy: { codigo: "asc" },
    });

    const payload = {
      competenciaCodigo: competencia?.codigo ?? "",
      exportedAt: new Date().toISOString(),
      raps: raps.map(r => ({
        codigo:      r.codigo,
        descripcion: r.descripcion,
        criterios:   r.criterios.map(c => ({ descripcion: c.descripcion, orden: c.orden })),
      })),
    };

    const filename = `raps-${competencia?.codigo ?? "export"}-${new Date().toISOString().slice(0,10)}.json`;
    reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Type", "application/json")
      .send(payload);
  });

  // ── M4: CRUD RAPs ───────────────────────────────────────────────────────────

  // GET /api/raps — lista RAPs de la competencia del usuario
  fastify.get("/api/raps", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const raps = await prisma.rAP.findMany({
      where:   { competenciaId },
      include: {
        criterios:     { orderBy: { orden: "asc" } },
        evidenciaRels: { select: { id: true } },
      },
      orderBy: { codigo: "asc" },
    });

    return raps.map(r => ({
      id:              r.id,
      codigo:          r.codigo,
      descripcion:     r.descripcion,
      criteriosCount:  r.criterios.length,
      evidenciasCount: r.evidenciaRels.length,
      criterios:       r.criterios.map(c => ({ id: c.id, descripcion: c.descripcion, orden: c.orden })),
    }));
  });

  // GET /api/raps/:rapId — detalle de un RAP con criterios y relaciones de evidencias
  fastify.get("/api/raps/:rapId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const rap = await prisma.rAP.findUnique({
      where:   { id: req.params.rapId },
      include: {
        criterios:     { orderBy: { orden: "asc" } },
        evidenciaRels: {
          include: {
            evidencia: {
              select: { id: true, nombre: true, tipo: true, ficha: { select: { id: true, codigo: true, nombre: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!rap)                                return reply.code(404).send({ error: "RAP no encontrado." });
    if (rap.competenciaId !== competenciaId) return reply.code(403).send({ error: "Sin acceso a este RAP." });

    return {
      id:          rap.id,
      codigo:      rap.codigo,
      descripcion: rap.descripcion,
      criterios:   rap.criterios.map(c => ({ id: c.id, descripcion: c.descripcion, orden: c.orden })),
      evidencias:  rap.evidenciaRels.map(rel => ({
        relId:      rel.id,
        id:         rel.evidencia.id,
        nombre:     rel.evidencia.nombre,
        tipo:       rel.evidencia.tipo,
        ficha:      rel.evidencia.ficha,
      })),
    };
  });

  // ── M4: Asociaciones RAP ↔ Evidencia ───────────────────────────────────────

  // GET /api/raps/:rapId/evidencias — evidencias asociadas a un RAP
  fastify.get("/api/raps/:rapId/evidencias", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const rap = await getRapParaUsuario(req.params.rapId, competenciaId, reply);
    if (!rap) return;

    const rels = await prisma.rapEvidenciaRel.findMany({
      where:   { rapId: rap.id },
      include: {
        evidencia: {
          select: {
            id:     true,
            nombre: true,
            tipo:   true,
            href:   true,
            ficha:  { select: { id: true, codigo: true, nombre: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return rels.map(rel => ({
      relId:  rel.id,
      id:     rel.evidencia.id,
      nombre: rel.evidencia.nombre,
      tipo:   rel.evidencia.tipo,
      href:   rel.evidencia.href,
      ficha:  rel.evidencia.ficha,
    }));
  });

  // POST /api/raps/:rapId/evidencias/:evidenciaId — asociar evidencia a RAP
  fastify.post("/api/raps/:rapId/evidencias/:evidenciaId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const rap = await getRapParaUsuario(req.params.rapId, competenciaId, reply);
    if (!rap) return;

    // Verificar que la evidencia pertenece a este usuario
    const evidencia = await prisma.evidencia.findUnique({
      where:   { id: req.params.evidenciaId },
      include: { ficha: { select: { userId: true } } },
    });
    if (!evidencia)                                return reply.code(404).send({ error: "Evidencia no encontrada." });
    if (evidencia.ficha.userId !== req.user.id)    return reply.code(403).send({ error: "Sin acceso a esta evidencia." });

    // Upsert para evitar duplicados con error amigable
    const rel = await prisma.rapEvidenciaRel.upsert({
      where:  { rapId_evidenciaId: { rapId: rap.id, evidenciaId: evidencia.id } },
      create: { rapId: rap.id, evidenciaId: evidencia.id },
      update: {},
    });

    return reply.code(201).send({ relId: rel.id, rapId: rel.rapId, evidenciaId: rel.evidenciaId });
  });

  // POST /api/raps/mapeo-lote — asociar múltiples evidencias a múltiples RAPs
  fastify.post("/api/raps/mapeo-lote", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const { mappings } = req.body;
    if (!mappings || !Array.isArray(mappings)) {
      return reply.code(400).send({ error: "Se requiere un arreglo 'mappings'." });
    }

    let successCount = 0;
    const upserts = [];

    // Validaciones
    for (const mapping of mappings) {
      const { rapId, evidenciaIds } = mapping;
      if (!rapId || !Array.isArray(evidenciaIds)) continue;

      const rap = await getRapParaUsuario(rapId, competenciaId, reply);
      if (!rap) return; // Si uno falla, abortamos todo el lote por seguridad

      for (const evidenciaId of evidenciaIds) {
        upserts.push(
          prisma.rapEvidenciaRel.upsert({
            where:  { rapId_evidenciaId: { rapId, evidenciaId } },
            create: { rapId, evidenciaId },
            update: {},
          })
        );
        successCount++;
      }
    }

    await prisma.$transaction(upserts);
    return reply.code(201).send({ success: true, count: successCount });
  });

  // DELETE /api/raps/:rapId/evidencias/:evidenciaId — quitar asociación
  fastify.delete("/api/raps/:rapId/evidencias/:evidenciaId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    const rap = await getRapParaUsuario(req.params.rapId, competenciaId, reply);
    if (!rap) return;

    const rel = await prisma.rapEvidenciaRel.findUnique({
      where: { rapId_evidenciaId: { rapId: rap.id, evidenciaId: req.params.evidenciaId } },
    });
    if (!rel) return reply.code(404).send({ error: "Asociación no encontrada." });

    await prisma.rapEvidenciaRel.delete({ where: { id: rel.id } });
    return reply.code(204).send();
  });

  // ── M5: Import ──────────────────────────────────────────────────────────────

  // POST /api/raps/import — importar RAPs desde JSON; upsert por codigo
  fastify.post("/api/raps/import", { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = req.body;
    if (!body || !Array.isArray(body.raps))
      return reply.code(400).send({ error: "El cuerpo debe tener la forma { raps: [...] }." });

    // Validar estructura mínima ANTES de tocar la DB
    for (const [i, r] of body.raps.entries()) {
      if (!r.codigo?.trim())      return reply.code(400).send({ error: `raps[${i}].codigo es requerido.` });
      if (!r.descripcion?.trim()) return reply.code(400).send({ error: `raps[${i}].descripcion es requerido.` });
      if (r.criterios !== undefined && !Array.isArray(r.criterios))
        return reply.code(400).send({ error: `raps[${i}].criterios debe ser un array.` });
    }

    const competenciaId = await getCompetenciaId(fastify, req, reply);
    if (!competenciaId) return;

    let created = 0;
    let updated = 0;
    const skipped = [];

    for (const r of body.raps) {
      const codigo = r.codigo.trim();
      const descripcion = r.descripcion.trim();
      const criterios = Array.isArray(r.criterios) ? r.criterios : [];

      try {
        const existing = await prisma.rAP.findUnique({
          where: { competenciaId_codigo: { competenciaId, codigo } },
        });

        if (existing) {
          // Reemplazar criterios y actualizar descripcion
          await prisma.$transaction([
            prisma.criterio.deleteMany({ where: { rapId: existing.id } }),
            prisma.rAP.update({
              where: { id: existing.id },
              data: {
                descripcion,
                criterios: {
                  create: criterios.map((c, i) => ({
                    descripcion: String(c.descripcion ?? "").trim(),
                    orden:       typeof c.orden === "number" ? c.orden : i,
                  })).filter(c => c.descripcion),
                },
              },
            }),
          ]);
          updated++;
        } else {
          await prisma.rAP.create({
            data: {
              competenciaId,
              codigo,
              descripcion,
              criterios: {
                create: criterios.map((c, i) => ({
                  descripcion: String(c.descripcion ?? "").trim(),
                  orden:       typeof c.orden === "number" ? c.orden : i,
                })).filter(c => c.descripcion),
              },
            },
          });
          created++;
        }
      } catch (err) {
        skipped.push({ codigo, error: err.message });
      }
    }

    return { created, updated, skipped };
  });
}

module.exports = rapsRoutes;
