const prisma = require("../db/client");

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function verificarFichaDelUsuario(fichaId, userId, reply) {
  let ficha;
  try { ficha = await prisma.ficha.findUnique({ where: { id: fichaId } }); }
  catch { reply.code(404).send({ error: "Ficha no encontrada." }); return null; }
  if (!ficha)                    { reply.code(404).send({ error: "Ficha no encontrada." }); return null; }
  if (ficha.userId !== userId)   { reply.code(403).send({ error: "Sin acceso a esta ficha." }); return null; }
  return ficha;
}

async function verificarActaDelUsuario(actaId, userId, reply) {
  let acta;
  try { acta = await prisma.actaSeguimiento.findUnique({ where: { id: actaId } }); }
  catch { reply.code(404).send({ error: "Acta no encontrada." }); return null; }
  if (!acta)                    { reply.code(404).send({ error: "Acta no encontrada." }); return null; }
  if (acta.userId !== userId)   { reply.code(403).send({ error: "Sin acceso a esta acta." }); return null; }
  return acta;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

async function actasRoutes(fastify) {

  // ── POST /api/actas ──────────────────────────────────────────────────────────
  fastify.post("/api/actas", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: "object",
        required: ["fichaId", "numero", "fecha", "hora", "objetivo", "rapIds"],
        properties: {
          fichaId:  { type: "string", minLength: 1 },
          numero:   { type: ["string", "number"] },
          fecha:    { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}" },
          hora:     { type: "string", minLength: 1 },
          lugar:    { type: "string" },
          objetivo: { type: "string", minLength: 1 },
          rapIds:   { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const { fichaId, numero, fecha, hora, lugar, objetivo, rapIds } = req.body || {};

    if (!fichaId || !numero || !fecha || !hora || !objetivo || !Array.isArray(rapIds)) {
      return reply.code(400).send({ error: "fichaId, numero, fecha, hora, objetivo y rapIds son requeridos." });
    }

    const ficha = await verificarFichaDelUsuario(fichaId, req.user.id, reply);
    if (!ficha) return;

    const acta = await prisma.actaSeguimiento.create({
      data: {
        userId:    req.user.id,
        fichaId,
        numero:    String(numero),
        fecha:     new Date(fecha),
        hora,
        lugar:     lugar || "Videoconferencia / Plataforma Zajuna",
        objetivo,
        rapIds,
        estado:    "borrador",
      },
    });

    return reply.code(201).send(acta);
  });

  // ── GET /api/actas ───────────────────────────────────────────────────────────
  fastify.get("/api/actas", { preHandler: fastify.authenticate }, async (req) => {
    const where = { userId: req.user.id };
    if (req.query?.fichaId) where.fichaId = req.query.fichaId;

    const actas = await prisma.actaSeguimiento.findMany({
      where,
      orderBy: { creadoAt: "desc" },
      include: {
        ficha:  { select: { codigo: true, nombre: true } },
        _count: { select: { participantes: true, mensajes: true } },
      },
    });

    return actas;
  });

  // ── GET /api/actas/:id ───────────────────────────────────────────────────────
  fastify.get("/api/actas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    const actaCompleta = await prisma.actaSeguimiento.findUnique({
      where:   { id: acta.id },
      include: {
        participantes: {
          include: {
            aprendiz: { select: { nombre: true, moodleId: true } },
          },
        },
        mensajes: {
          select: {
            id:           true,
            canal:        true,
            asunto:       true,
            estado:       true,
            enviadoAt:    true,
            creadoAt:     true,
            destinatarios: true,
          },
        },
      },
    });

    const rapIds = Array.isArray(acta.rapIds) ? acta.rapIds : [];
    const rapsInfo = rapIds.length > 0
      ? await prisma.rAP.findMany({
          where:  { id: { in: rapIds } },
          select: { id: true, codigo: true, descripcion: true },
        })
      : [];

    const mensajesResumen = actaCompleta.mensajes.map(m => ({
      id:                 m.id,
      canal:              m.canal,
      asunto:             m.asunto,
      estado:             m.estado,
      enviadoAt:          m.enviadoAt,
      creadoAt:           m.creadoAt,
      destinatariosCount: Array.isArray(m.destinatarios) ? m.destinatarios.length : 0,
    }));

    return {
      ...actaCompleta,
      mensajes:  mensajesResumen,
      rapsInfo,
    };
  });

  // ── PATCH /api/actas/:id ─────────────────────────────────────────────────────
  fastify.patch("/api/actas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    if (acta.estado !== "borrador") {
      return reply.code(422).send({ error: "Solo se pueden editar actas en estado borrador." });
    }

    const { conclusiones, compromisos, hora, lugar, objetivo, rapIds } = req.body || {};

    const data = {};
    if (conclusiones !== undefined) data.conclusiones = conclusiones;
    if (compromisos  !== undefined) data.compromisos  = compromisos;
    if (hora         !== undefined) data.hora         = hora;
    if (lugar        !== undefined) data.lugar        = lugar;
    if (objetivo     !== undefined) data.objetivo     = objetivo;
    if (rapIds       !== undefined) data.rapIds       = rapIds;

    const actualizada = await prisma.actaSeguimiento.update({
      where: { id: acta.id },
      data,
    });

    return actualizada;
  });

  // ── POST /api/actas/:id/participantes ────────────────────────────────────────
  fastify.post("/api/actas/:id/participantes", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    if (acta.estado !== "borrador") {
      return reply.code(422).send({ error: "Solo se pueden modificar participantes en actas borrador." });
    }

    const juicios = req.body;
    if (!Array.isArray(juicios) || juicios.length === 0) {
      return reply.code(400).send({ error: "Se requiere un array de { aprendizId, juicio }." });
    }

    const JUICIOS_VALIDOS = ["APROBÓ", "NO ASISTIÓ", "PENDIENTE"];

    for (const j of juicios) {
      if (!j.aprendizId || !JUICIOS_VALIDOS.includes(j.juicio)) {
        return reply.code(400).send({ error: `Juicio inválido para aprendizId ${j.aprendizId}. Valores válidos: ${JUICIOS_VALIDOS.join(", ")}.` });
      }
    }

    await Promise.all(juicios.map(j =>
      prisma.actaParticipante.upsert({
        where:  { actaId_aprendizId: { actaId: acta.id, aprendizId: j.aprendizId } },
        create: { actaId: acta.id, aprendizId: j.aprendizId, juicio: j.juicio },
        update: { juicio: j.juicio },
      })
    ));

    const count = await prisma.actaParticipante.count({ where: { actaId: acta.id } });
    return { participantesCount: count };
  });

  // ── POST /api/actas/:id/auto-poblar ─────────────────────────────────────────
  fastify.post("/api/actas/:id/auto-poblar", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    if (acta.estado !== "borrador") {
      return reply.code(422).send({ error: "Solo se puede auto-poblar actas en estado borrador." });
    }

    const rapIds = Array.isArray(acta.rapIds) ? acta.rapIds : [];
    if (rapIds.length === 0) {
      return reply.code(422).send({ error: "El acta no tiene RAPs asociados." });
    }

    // Buscar evidencias asociadas a los RAPs que pertenezcan a la ficha del acta
    const rels = await prisma.rapEvidenciaRel.findMany({
      where:   { rapId: { in: rapIds } },
      include: { evidencia: { select: { id: true, fichaId: true } } },
    });

    const evidenciaIds = [
      ...new Set(
        rels
          .filter(r => r.evidencia.fichaId === acta.fichaId)
          .map(r => r.evidencia.id)
      ),
    ];

    // Obtener aprendices de la ficha
    const aprendices = await prisma.aprendiz.findMany({
      where: { fichaId: acta.fichaId },
      select: { id: true },
    });

    const aprendizIds = aprendices.map(a => a.id);

    // 1 query para todas las entregas relevantes (antes: 1 query × N aprendices)
    const todasEntregas = evidenciaIds.length > 0
      ? await prisma.entrega.findMany({
          where: {
            aprendizId:  { in: aprendizIds },
            evidenciaId: { in: evidenciaIds },
          },
          select: { aprendizId: true, estado: true, notaActual: true },
        })
      : [];

    // Agrupar en memoria por aprendizId
    const entregasPorAprendiz = new Map();
    for (const e of todasEntregas) {
      if (!entregasPorAprendiz.has(e.aprendizId)) entregasPorAprendiz.set(e.aprendizId, []);
      entregasPorAprendiz.get(e.aprendizId).push(e);
    }

    // Calcular juicio y preparar upserts (sin ejecutar aún)
    let aprobaron    = 0;
    let pendientes   = 0;
    let noAsistieron = 0;

    const upserts = aprendices.map(aprendiz => {
      let juicio = "NO ASISTIÓ";
      const entregas = entregasPorAprendiz.get(aprendiz.id) ?? [];

      if (entregas.length > 0) {
        const todasAprobadas = entregas.every(e =>
          (e.notaActual !== null && e.notaActual > 0) ||
          /aprobad|^A$/i.test(e.estado ?? "")
        );
        juicio = todasAprobadas ? "APROBÓ" : "PENDIENTE";
      }

      if (juicio === "APROBÓ")         aprobaron++;
      else if (juicio === "PENDIENTE") pendientes++;
      else                             noAsistieron++;

      return prisma.actaParticipante.upsert({
        where:  { actaId_aprendizId: { actaId: acta.id, aprendizId: aprendiz.id } },
        create: { actaId: acta.id, aprendizId: aprendiz.id, juicio },
        update: { juicio },
      });
    });

    // 1 transacción atómica para todos los upserts (antes: 1 upsert × N aprendices)
    await prisma.$transaction(upserts);

    return {
      poblados:     aprendices.length,
      aprobaron,
      pendientes,
      noAsistieron,
    };
  });

  // ── POST /api/actas/:id/cerrar ───────────────────────────────────────────────
  fastify.post("/api/actas/:id/cerrar", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    const actualizada = await prisma.actaSeguimiento.update({
      where: { id: acta.id },
      data:  { estado: "cerrada" },
    });

    return actualizada;
  });

  // ── GET /api/actas/:id/download ─────────────────────────────────────────────
  fastify.get("/api/actas/:id/download", { preHandler: fastify.authenticate }, async (req, reply) => {
    const {
      Document, Paragraph, Table, TableRow, TableCell, TextRun,
      HeadingLevel, AlignmentType, WidthType, BorderStyle, Packer,
    } = require("docx");

    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    const actaCompleta = await prisma.actaSeguimiento.findUnique({
      where:   { id: acta.id },
      include: {
        ficha:        { select: { codigo: true, nombre: true } },
        participantes: {
          include: { aprendiz: { select: { nombre: true } } },
        },
      },
    });

    const rapIds = Array.isArray(acta.rapIds) ? acta.rapIds : [];
    const rapsInfo = rapIds.length > 0
      ? await prisma.rAP.findMany({
          where:  { id: { in: rapIds } },
          select: { id: true, codigo: true, descripcion: true },
        })
      : [];

    const compromisos = Array.isArray(acta.compromisos) ? acta.compromisos : [];
    const ficha       = actaCompleta.ficha || {};
    const participantes = actaCompleta.participantes || [];

    // ── Helpers de estilo ────────────────────────────────────────────────────

    const THIN_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
    const cellBorders = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };

    function headerCell(text) {
      return new TableCell({
        borders: cellBorders,
        shading: { fill: "2E4057" },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text, bold: true, color: "FFFFFF", size: 20 })],
          }),
        ],
      });
    }

    function dataCell(text, opts = {}) {
      return new TableCell({
        borders: cellBorders,
        children: [
          new Paragraph({
            alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [new TextRun({ text: String(text ?? ""), size: 20 })],
          }),
        ],
      });
    }

    function sectionHeading(text) {
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 },
        children: [new TextRun({ text, bold: true, size: 24, color: "2E4057" })],
      });
    }

    function bodyText(text) {
      return new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: String(text ?? ""), size: 20 })],
      });
    }

    // ── Título ───────────────────────────────────────────────────────────────

    const titulo = new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `ACTA DE SEGUIMIENTO N° ${acta.numero}`, bold: true, size: 32, color: "2E4057" }),
      ],
    });

    const subtitulo = new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `Ficha: ${ficha.codigo ?? ""} — ${ficha.nombre ?? ""}`, size: 22, italics: true }),
      ],
    });

    const fechaStr = acta.fecha
      ? new Date(acta.fecha).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })
      : "";

    const metaLinea = new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: `Fecha: ${fechaStr}  |  Hora: ${acta.hora ?? ""}  |  Lugar: ${acta.lugar ?? ""}`, size: 20 }),
      ],
    });

    // ── Objetivo ─────────────────────────────────────────────────────────────

    const seccionObjetivo = [
      sectionHeading("OBJETIVO"),
      bodyText(acta.objetivo ?? ""),
    ];

    // ── RAPs ─────────────────────────────────────────────────────────────────

    const seccionRaps = [];
    if (rapsInfo.length > 0) {
      seccionRaps.push(sectionHeading("RESULTADOS DE APRENDIZAJE EVALUADOS"));
      for (const rap of rapsInfo) {
        seccionRaps.push(bodyText(`• ${rap.codigo}: ${rap.descripcion}`));
      }
    }

    // ── Participantes ────────────────────────────────────────────────────────

    const filasParticipantes = [
      new TableRow({
        tableHeader: true,
        children: [headerCell("Aprendiz"), headerCell("Juicio")],
      }),
      ...participantes.map(p =>
        new TableRow({
          children: [
            dataCell(p.aprendiz?.nombre ?? ""),
            dataCell(p.juicio ?? "", { center: true }),
          ],
        })
      ),
    ];

    if (participantes.length === 0) {
      filasParticipantes.push(
        new TableRow({
          children: [
            new TableCell({
              borders: cellBorders,
              columnSpan: 2,
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Sin participantes registrados.", size: 20, italics: true })] })],
            }),
          ],
        })
      );
    }

    const tablaParticipantes = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: filasParticipantes,
    });

    const seccionParticipantes = [
      sectionHeading("PARTICIPANTES"),
      tablaParticipantes,
    ];

    // ── Conclusiones ─────────────────────────────────────────────────────────

    const seccionConclusiones = [
      sectionHeading("CONCLUSIONES"),
      bodyText(acta.conclusiones || "Sin conclusiones registradas."),
    ];

    // ── Compromisos ──────────────────────────────────────────────────────────

    const filasCompromisos = [
      new TableRow({
        tableHeader: true,
        children: [headerCell("Actividad"), headerCell("Fecha"), headerCell("Responsable")],
      }),
      ...compromisos.map(c =>
        new TableRow({
          children: [
            dataCell(c.actividad ?? ""),
            dataCell(c.fecha ?? "", { center: true }),
            dataCell(c.responsable ?? ""),
          ],
        })
      ),
    ];

    if (compromisos.length === 0) {
      filasCompromisos.push(
        new TableRow({
          children: [
            new TableCell({
              borders: cellBorders,
              columnSpan: 3,
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Sin compromisos registrados.", size: 20, italics: true })] })],
            }),
          ],
        })
      );
    }

    const tablaCompromisos = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: filasCompromisos,
    });

    const seccionCompromisos = [
      sectionHeading("COMPROMISOS"),
      tablaCompromisos,
    ];

    // ── Firma ────────────────────────────────────────────────────────────────

    const seccionFirma = [
      sectionHeading("FIRMA"),
      new Paragraph({
        spacing: { before: 400 },
        children: [
          new TextRun({ text: "Instructor: _______________________________", size: 20 }),
          new TextRun({ text: "          Fecha: ___________________", size: 20 }),
        ],
      }),
    ];

    // ── Armar documento ──────────────────────────────────────────────────────

    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          titulo,
          subtitulo,
          metaLinea,
          ...seccionObjetivo,
          ...seccionRaps,
          ...seccionParticipantes,
          ...seccionConclusiones,
          ...seccionCompromisos,
          ...seccionFirma,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);

    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="acta-${acta.numero}.docx"`)
      .send(buffer);
  });
}

module.exports = actasRoutes;
