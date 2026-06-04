/**
 * api/src/routes/actas.js — Actas de seguimiento (módulo M7).
 *
 * QUÉ HACE: gestiona las "actas de seguimiento" del SENA — el documento donde el
 * instructor registra, por aprendiz y por RAP (Resultado de Aprendizaje), si
 * aprobó/reprobó cada evidencia. Expone el CRUD del acta, el auto-poblado desde
 * los datos ya scrapeados, y la descarga en Word (formato institucional GOR-F-084).
 *
 * CONCEPTO CLAVE — el mapa RAP → Evidencias:
 *   Un acta evalúa RAPs, pero las notas viven en Evidencias. El puente son dos
 *   tablas: `RapEvidenciaRel` (vínculo manual/IA) y `MatchingPropuesta(aceptado)`.
 *   `auto-poblar` y `preview-native` arman ese mapa SOLO desde esas dos tablas.
 *   ⚠️ BLOQUEADOR CONOCIDO (jun 2026): ambas están VACÍAS en la DB
 *   (`RapEvidenciaRel = 0`), así que estos endpoints devuelven 422
 *   `RAP_SIN_EVIDENCIAS` a todo. Fix: correr `scripts/vincularEvidenciasRAPs.js`.
 *   Ver CLAUDE.md §"Paso 0" y la memoria project_actas_blocker.
 *
 * REGLAS DE NEGOCIO (no tocar sin discutir, ver CLAUDE.md §5):
 *   - Umbral de aprobación 70/100 + cualitativa A (calcularEstado/esAprobada en
 *     lib/calificacion.js). Una evidencia `sin_entregar` cuenta como NO aprobada.
 *   - Multi-tenant: todo pasa por verificarFichaDelUsuario/verificarActaDelUsuario.
 *
 * ÍNDICE DE RUTAS (todas requieren JWT):
 *   POST   /api/actas                         crear acta
 *   GET    /api/actas                         listar actas del usuario
 *   GET    /api/actas/:id                     detalle (con participantes)
 *   PATCH  /api/actas/:id                     editar metadatos
 *   DELETE /api/actas/:id                     borrar acta
 *   POST   /api/actas/:id/participantes       agregar participante manual
 *   DELETE /api/actas/:id/participantes/:pid  quitar participante
 *   POST   /api/actas/:id/auto-poblar         ★ llenar juicios desde RAP↔Evidencia
 *   POST   /api/actas/:id/cerrar              cerrar acta (estado final)
 *   GET    /api/actas/:id/download            descargar Word genérico
 *   GET    /api/actas/:id/download/gor-f-084  descargar Word formato SENA oficial
 *   POST   /api/actas/preview-native          ★ previsualizar acta nativa (sin crear)
 *   POST   /api/actas/confirm-native          confirmar y crear acta nativa
 */

const prisma = require("../db/client");
const { filtrarAprendicesValidos } = require("../lib/aprendices");
const { calcularEstado, calcularJuicio } = require("../lib/calificacion");

// ─── Helpers de autorización (IDOR check multi-tenant) ──────────────────────────

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
    const incluirArchivadas = req.query?.incluirArchivadas === "1";
    where.archivadaAt = incluirArchivadas ? undefined : null;

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
          select: {
            id:          true,
            aprendizId:  true,
            juicio:      true,
            rapStatus:   true,
            hasUngraded: true,
            aprendiz: { select: { nombre: true, moodleId: true } },
          },
          orderBy: { aprendiz: { nombre: "asc" } },
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

    const { conclusiones, compromisos, hora, lugar, objetivo, rapIds, archivada, notas } = req.body || {};

    // archivada toggle works for any estado; other edits require borrador
    if (acta.estado !== "borrador" && typeof archivada !== "boolean") {
      return reply.code(422).send({ error: "Solo se pueden editar actas en estado borrador." });
    }

    const data = {};
    if (typeof archivada === "boolean")  data.archivadaAt  = archivada ? new Date() : null;
    if (conclusiones !== undefined) data.conclusiones = conclusiones;
    if (compromisos  !== undefined) data.compromisos  = compromisos;
    if (hora         !== undefined) data.hora         = hora;
    if (lugar        !== undefined) data.lugar        = lugar;
    if (objetivo     !== undefined) data.objetivo     = objetivo;
    if (rapIds       !== undefined) data.rapIds       = rapIds;
    if (notas        !== undefined) data.notas        = notas;

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

    const JUICIOS_VALIDOS = ["APROBÓ", "PENDIENTE", "NO PARTICIPÓ"];

    for (const j of juicios) {
      if (!j.aprendizId || !JUICIOS_VALIDOS.includes(j.juicio)) {
        return reply.code(400).send({ error: `Juicio inválido para aprendizId ${j.aprendizId}. Valores válidos: ${JUICIOS_VALIDOS.join(", ")}.` });
      }
    }

    await Promise.all(juicios.map(j =>
      prisma.actaParticipante.upsert({
        where:  { actaId_aprendizId: { actaId: acta.id, aprendizId: j.aprendizId } },
        create: { actaId: acta.id, aprendizId: j.aprendizId, juicio: j.juicio, rapStatus: j.rapStatus ?? undefined },
        update: { juicio: j.juicio, ...(j.rapStatus !== undefined && { rapStatus: j.rapStatus }) },
      })
    ));

    const count = await prisma.actaParticipante.count({ where: { actaId: acta.id } });
    return { participantesCount: count };
  });

  // ── DELETE /api/actas/:id ────────────────────────────────────────────────────
  fastify.delete("/api/actas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    await prisma.actaParticipante.deleteMany({ where: { actaId: acta.id } });
    await prisma.actaSeguimiento.delete({ where: { id: acta.id } });

    return reply.code(200).send({ deleted: true });
  });

  // ── DELETE /api/actas/:id/participantes/:participanteId ───────────────────────
  fastify.delete("/api/actas/:id/participantes/:participanteId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    if (acta.estado !== "borrador") {
      return reply.code(422).send({ error: "Solo se pueden eliminar participantes en actas borrador." });
    }

    const participante = await prisma.actaParticipante.findUnique({
      where: { id: req.params.participanteId },
    });
    if (!participante || participante.actaId !== acta.id) {
      return reply.code(404).send({ error: "Participante no encontrado en esta acta." });
    }

    await prisma.actaParticipante.delete({ where: { id: req.params.participanteId } });
    return reply.code(200).send({ deleted: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-POBLADO — corazón del módulo. Cruza RAP↔Evidencia↔Entrega y calcula, por
  // participante y por RAP, el juicio (aprobó/no) con las reglas SENA. Aquí pega
  // el bloqueador RapEvidenciaRel=0 (ver cabecera del archivo).
  // ═══════════════════════════════════════════════════════════════════════════

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

    // ── Obtener RAPs con su código ──────────────────────────────────────────────
    const rapsInfo = await prisma.rAP.findMany({
      where:  { id: { in: rapIds } },
      select: { id: true, codigo: true },
    });
    const rapCodigoPorId = new Map(rapsInfo.map(r => [r.id, r.codigo]));

    // ── Evidencias por RAP (confirmadas + IA aceptadas) ────────────────────────
    const [relsConfirmadas, relsIA] = await Promise.all([
      prisma.rapEvidenciaRel.findMany({
        where:  { rapId: { in: rapIds }, evidencia: { fichaId: acta.fichaId } },
        select: { rapId: true, evidenciaId: true },
      }),
      prisma.matchingPropuesta.findMany({
        where:  { rapId: { in: rapIds }, estado: "aceptado", evidencia: { fichaId: acta.fichaId } },
        select: { rapId: true, evidenciaId: true },
      }),
    ]);

    // Mapa: rapId → Set<evidenciaId>
    const mapaRapEvidencias = new Map();
    for (const rel of [...relsConfirmadas, ...relsIA]) {
      if (!mapaRapEvidencias.has(rel.rapId)) mapaRapEvidencias.set(rel.rapId, new Set());
      mapaRapEvidencias.get(rel.rapId).add(rel.evidenciaId);
    }

    const todasEvidenciaIds = [...new Set([...relsConfirmadas, ...relsIA].map(r => r.evidenciaId))];

    // ── Aprendices de la ficha (filtrando nombres inválidos: AA, AG, ABALEJANDRO…)
    // Cargamos el conteo de entregas para poder deduplicar (sucio vs limpio).
    const aprendicesRaw = await prisma.aprendiz.findMany({
      where:  { fichaId: acta.fichaId },
      select: { id: true, nombre: true, _count: { select: { entregas: true } } },
    });
    const aprendicesValidos = filtrarAprendicesValidos(aprendicesRaw);

    // ── Deduplicar: eliminar variantes sucias que son el mismo aprendiz ─────────
    // "ACADRIAN MAURICIO CALDERON" y "ADRIAN MAURICIO CALDERON" son el mismo
    // aprendiz — uno tiene prefijo de iniciales en el primer token.
    // Estrategia: si el primer token de un nombre A, al quitarle 2-3 chars
    // iniciales, coincide con el primer token de un nombre B en la misma ficha,
    // son duplicados. Quedarse con el que tiene más entregas; si empatan, el más
    // corto (el limpio). El otro se excluye del resultado (NO se borra de DB).
    function nucleoPrimerToken(nombre) {
      const tok = nombre.split(/\s+/)[0];
      const m = tok.match(/^[A-Z]{2,3}([A-Z].*)$/);
      return m ? m[1] : tok;
    }

    // Agrupar por (fichaId implícita + núcleo del primer token + resto del nombre)
    // Clave = núcleo primer token + tokens 2+ en minúsculas para comparación flexible
    function claveNombre(nombre) {
      const tokens = nombre.trim().split(/\s+/);
      const nucleo = nucleoPrimerToken(nombre);
      const resto  = tokens.slice(1).join(" ").toLowerCase();
      return `${nucleo.toLowerCase()}|${resto}`;
    }

    const grupoDuplicados = new Map(); // clave → [aprendiz, ...]
    for (const a of aprendicesValidos) {
      const k = claveNombre(a.nombre);
      if (!grupoDuplicados.has(k)) grupoDuplicados.set(k, []);
      grupoDuplicados.get(k).push(a);
    }

    const aprendicesFinal = [];
    for (const grupo of grupoDuplicados.values()) {
      if (grupo.length === 1) {
        aprendicesFinal.push(grupo[0]);
      } else {
        // Múltiples aprendices con el mismo nombre canónico → elegir el mejor
        grupo.sort((a, b) => {
          const diffEntregas = (b._count.entregas) - (a._count.entregas);
          if (diffEntregas !== 0) return diffEntregas;   // más entregas primero
          return a.nombre.length - b.nombre.length;      // más corto (limpio) primero
        });
        aprendicesFinal.push(grupo[0]);
      }
    }

    const aprendices = aprendicesFinal.map(a => ({ id: a.id, nombre: a.nombre }));
    const nFiltrados = aprendicesRaw.length - aprendices.length;
    const aprendizIds = aprendices.map(a => a.id);

    // ── Validación Mapeo al Vuelo ───────────────────────────────────────────────
    // Detectar RAPs que no tienen evidencias vinculadas para notificar a la UI
    // y evitar el fallback silencioso que dejaba a todos en PENDIENTE.
    const rapsSinEvidencias = [];
    for (const rapId of rapIds) {
      const evidenciasDelRap = mapaRapEvidencias.get(rapId);
      if (!evidenciasDelRap || evidenciasDelRap.size === 0) {
        rapsSinEvidencias.push({
          id: rapId,
          codigo: rapCodigoPorId.get(rapId) || rapId
        });
      }
    }

    if (rapsSinEvidencias.length > 0) {
      return reply.code(422).send({
        error: "RAP_SIN_EVIDENCIAS",
        message: "Hay RAPs seleccionados que no tienen evidencias vinculadas.",
        rapsSinEvidencias
      });
    }

    // Al pasar la validación, garantizamos que todas las evidencias están mapeadas,
    // por ende, el modo siempre será per-RAP.
    const modoPerRap = true;

    // ── Cargar entregas relevantes ──────────────────────────────────────────────
    // En modo per-RAP: solo entregas de evidencias vinculadas a los RAPs.
    // En modo fallback: todas las entregas del aprendiz en evidencias de la ficha.
    let todasEntregas;
    if (modoPerRap) {
      todasEntregas = await prisma.entrega.findMany({
        where: {
          aprendizId:  { in: aprendizIds },
          evidenciaId: { in: todasEvidenciaIds },
        },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true },
      });
    } else {
      todasEntregas = await prisma.entrega.findMany({
        where: {
          aprendizId: { in: aprendizIds },
          evidencia:  { fichaId: acta.fichaId },
        },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true },
      });
    }

    // Agrupar entregas: aprendizId → array
    const entregasPorAprendiz = new Map();
    for (const e of todasEntregas) {
      if (!entregasPorAprendiz.has(e.aprendizId)) entregasPorAprendiz.set(e.aprendizId, []);
      entregasPorAprendiz.get(e.aprendizId).push(e);
    }

    // Helpers de clasificación (esAprobada/calcularEstado/calcularJuicio) viven
    // en ../lib/calificacion para deduplicar y poder testearlos en aislamiento.

    // ── Calcular rapStatus + juicio + hasUngraded por aprendiz ─────────────────
    let nAprobaron = 0, nPendientes = 0, nNoParticiparon = 0, nWarnings = 0;

    const upserts = aprendices.map(aprendiz => {
      const entregasAprendiz = entregasPorAprendiz.get(aprendiz.id) ?? [];
      const rapStatus = {};
      let hasUngraded = false;

      if (modoPerRap) {
        // Modo preciso: una columna por RAP basada en sus evidencias vinculadas.
        // Para cada evidencia vinculada al RAP, si el aprendiz NO tiene entrega
        // se inyecta una virtual "sin_entregar" — así entregas.every() refleja
        // correctamente "TODAS las evidencias del RAP" (no solo las que existen).
        const entregasMap = new Map(entregasAprendiz.map(e => [e.evidenciaId, e]));
        for (const rapId of rapIds) {
          const codigo = rapCodigoPorId.get(rapId) ?? rapId;
          const evidIds = mapaRapEvidencias.get(rapId) ?? new Set();
          const entregasDelRap = [...evidIds].map(eid =>
            entregasMap.get(eid) ?? { evidenciaId: eid, estado: "sin_entregar", notaActual: null }
          );
          const r = calcularEstado(entregasDelRap);
          rapStatus[codigo] = r.estado;
          if (r.hasUngraded) hasUngraded = true;
        }
      } else {
        // Fallback: juicio global desde TODAS las entregas del aprendiz en la
        // ficha. Lo replicamos en cada RAP del acta para que la UI tenga celda
        // por RAP y el instructor pueda overridear manualmente.
        const r = calcularEstado(entregasAprendiz);
        for (const rapId of rapIds) {
          const codigo = rapCodigoPorId.get(rapId) ?? rapId;
          rapStatus[codigo] = r.estado;
        }
        if (r.hasUngraded) hasUngraded = true;
      }

      // JUICIO GENERAL — REGLAS ESTRICTAS (ver lib/calificacion).
      const juicio = calcularJuicio(Object.values(rapStatus));
      if      (juicio === "APROBÓ")       nAprobaron++;
      else if (juicio === "NO PARTICIPÓ") nNoParticiparon++;
      else                                nPendientes++;

      if (hasUngraded) nWarnings++;

      return prisma.actaParticipante.upsert({
        where:  { actaId_aprendizId: { actaId: acta.id, aprendizId: aprendiz.id } },
        create: { actaId: acta.id, aprendizId: aprendiz.id, juicio, rapStatus, hasUngraded },
        update: { juicio, rapStatus, hasUngraded },
      });
    });

    await prisma.$transaction(upserts);

    return {
      poblados:             aprendices.length,
      aprobaron:            nAprobaron,
      pendientes:           nPendientes,
      noParticiparon:       nNoParticiparon,
      warnings:             nWarnings,
      filtrados:            nFiltrados,
      evidenciasVinculadas: todasEvidenciaIds.length,
      modo:                 modoPerRap ? "per-rap" : "global-fallback",
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERACIÓN DE WORD — arma el .docx del acta. `download` = formato genérico;
  // `download/gor-f-084` = plantilla institucional SENA oficial. Ambas leen el
  // acta ya poblada y la serializan a Word (sin tocar Moodle).
  // ═══════════════════════════════════════════════════════════════════════════

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
        children: [
          headerCell("Aprendiz"),
          ...rapsInfo.map(r => {
            const num = r.codigo.match(/-?(\d+)$/)?.[1];
            return headerCell(num ? `RAP ${num}` : r.codigo);
          }),
          headerCell("Juicio"),
        ],
      }),
      ...participantes.map(p => {
        const rs = p.rapStatus && typeof p.rapStatus === "object" ? p.rapStatus : null;
        const rapCells = rapsInfo.map(r => {
          const val = rs?.[r.codigo] ?? "NO PARTICIPÓ";
          return dataCell(
            val === "APROBÓ" ? "Aprobó" : val === "PENDIENTE" ? "Pendiente" : "No participó",
            { center: true }
          );
        });
        const jTexto = p.juicio === "APROBÓ" ? "Aprobó" : p.juicio === "PENDIENTE" ? "Pendiente" : "No participó";
        return new TableRow({
          children: [dataCell(p.aprendiz?.nombre ?? ""), ...rapCells, dataCell(jTexto, { center: true })],
        });
      }),
    ];

    if (participantes.length === 0) {
      filasParticipantes.push(
        new TableRow({
          children: [
            new TableCell({
              borders: cellBorders,
              columnSpan: 2 + rapsInfo.length,
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

  // ── GET /api/actas/:id/download/gor-f-084 ────────────────────────────────────
  // Genera Word en formato institucional GOR-F-084 V02 del SENA.
  fastify.get("/api/actas/:id/download/gor-f-084", { preHandler: fastify.authenticate }, async (req, reply) => {
    const {
      Document, Paragraph, Table, TableRow, TableCell, TextRun,
      AlignmentType, WidthType, BorderStyle, Packer, VerticalAlign,
    } = require("docx");

    const acta = await verificarActaDelUsuario(req.params.id, req.user.id, reply);
    if (!acta) return;

    // ── Datos ────────────────────────────────────────────────────────────────
    const actaCompleta = await prisma.actaSeguimiento.findUnique({
      where:   { id: acta.id },
      include: {
        ficha:        { select: { codigo: true, nombre: true, programa: true } },
        participantes: {
          select: {
            id:          true,
            aprendizId:  true,
            juicio:      true,
            rapStatus:   true,
            hasUngraded: true,
            aprendiz: { select: { nombre: true, documento: true } },
          },
          orderBy: { aprendiz: { nombre: "asc" } },
        },
      },
    });

    const rapIds   = Array.isArray(acta.rapIds) ? acta.rapIds : [];
    const rapsInfo = rapIds.length > 0
      ? await prisma.rAP.findMany({
          where:  { id: { in: rapIds } },
          select: { id: true, codigo: true, descripcion: true },
          orderBy: { codigo: "asc" },
        })
      : [];

    // Warning counts: unpacking destinatarios JSON en DB
    let warningPorNombre = new Map();
    try {
      const rows = await prisma.$queryRaw`
        SELECT
          a.nombre,
          COUNT(*)::int AS warning_count
        FROM "MensajeFormativo" mf,
             jsonb_array_elements(mf.destinatarios) AS elem
        JOIN "Aprendiz" a ON a.id = (elem->>'aprendizId')
        WHERE mf."fichaId" = ${acta.fichaId}
          AND mf.estado = 'enviado'
        GROUP BY a.nombre
      `;
      warningPorNombre = new Map(
        rows.map(r => [r.nombre.toUpperCase().trim(), Number(r.warning_count)])
      );
    } catch (_) {}

    const ficha        = actaCompleta.ficha || {};
    const participantes = actaCompleta.participantes || [];

    // ── Conteos resumen ───────────────────────────────────────────────────────
    let nAprobaron   = 0;
    let nPendientes  = 0;
    let nNoParticipo = 0;

    for (const p of participantes) {
      const j = p.juicio;
      if (j === "APROBÓ")                                   nAprobaron++;
      else if (j === "EVIDENCIAS PENDIENTES" || j === "PENDIENTE") nPendientes++;
      else                                                   nNoParticipo++;
    }

    // ── Helpers de estilo ──────────────────────────────────────────────────────

    const BORDE = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
    const BORDES = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE };
    const VERDE_SENA = "39A900";
    const GRIS_HEADER = "CCCCCC";

    function celda(texto, opts = {}) {
      return new TableCell({
        borders:    BORDES,
        shading:    opts.bg ? { fill: opts.bg } : undefined,
        verticalAlign: VerticalAlign.CENTER,
        width:      opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
        columnSpan: opts.span,
        children: [
          new Paragraph({
            alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
            children: [
              new TextRun({
                text:  String(texto ?? ""),
                bold:  opts.bold,
                size:  opts.size || 18,
                color: opts.color,
              }),
            ],
          }),
        ],
      });
    }

    function fila(...celdas) {
      return new TableRow({ children: celdas });
    }

    function tabla(rows, widthPct = 100) {
      return new Table({
        width: { size: widthPct, type: WidthType.PERCENTAGE },
        rows,
      });
    }

    function parrafo(texto, opts = {}) {
      return new Paragraph({
        spacing: { before: opts.before ?? 80, after: opts.after ?? 60 },
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [
          new TextRun({
            text:    String(texto ?? ""),
            bold:    opts.bold,
            size:    opts.size || 20,
            color:   opts.color,
            italics: opts.italics,
          }),
        ],
      });
    }

    const fechaStr = acta.fecha
      ? new Date(acta.fecha).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })
      : "";

    // ── Sección 1: Header institucional ───────────────────────────────────────
    const headerTabla = tabla([
      fila(
        celda("SERVICIO NACIONAL DE APRENDIZAJE\nSENA", { bold: true, center: true, size: 18, bg: VERDE_SENA, color: "FFFFFF", width: 2880 }),
        celda("ACTA DE SEGUIMIENTO DE FORMACIÓN\nGOR-F-084 V02", { bold: true, center: true, size: 20, width: 6120 }),
        celda(`FECHA: ${fechaStr}`, { center: true, size: 16, width: 1800 }),
      ),
    ]);

    // ── Sección 2: Info general del acta ──────────────────────────────────────
    const infoTabla = tabla([
      fila(
        celda("PROGRAMA:", { bold: true, bg: GRIS_HEADER, width: 2000 }),
        celda(ficha.programa || "", { width: 4600 }),
        celda("N° ACTA:", { bold: true, bg: GRIS_HEADER, width: 1200 }),
        celda(acta.numero, { center: true, bold: true, width: 1000 }),
      ),
      fila(
        celda("FICHA:", { bold: true, bg: GRIS_HEADER }),
        celda(ficha.codigo || "", {}),
        celda("HORA:", { bold: true, bg: GRIS_HEADER }),
        celda(acta.hora || "", { center: true }),
      ),
      fila(
        celda("NOMBRE DEL PROGRAMA:", { bold: true, bg: GRIS_HEADER }),
        celda(ficha.nombre || "", { span: 3 }),
      ),
      fila(
        celda("LUGAR:", { bold: true, bg: GRIS_HEADER }),
        celda(acta.lugar || "", { span: 3 }),
      ),
    ]);

    // ── Sección 3: Objetivo ────────────────────────────────────────────────────
    const objetivoTabla = tabla([
      fila(celda("OBJETIVO DE LA SESIÓN", { bold: true, center: true, bg: GRIS_HEADER, span: 1 })),
      fila(celda(acta.objetivo || "", {})),
    ]);

    // ── Sección 4: RAPs evaluados ─────────────────────────────────────────────
    const rapFilas = [
      fila(celda("RESULTADOS DE APRENDIZAJE EVALUADOS", { bold: true, center: true, bg: GRIS_HEADER })),
    ];
    if (rapsInfo.length > 0) {
      for (const r of rapsInfo) {
        rapFilas.push(fila(celda(`${r.codigo}: ${r.descripcion}`, { size: 18 })));
      }
    } else {
      rapFilas.push(fila(celda("(Sin RAPs asociados)", { italics: true })));
    }
    const rapsTabla = tabla(rapFilas);

    // ── Sección 5: Tabla de participantes ─────────────────────────────────────
    const partFilas = [
      fila(
        celda("N°",          { bold: true, center: true, bg: GRIS_HEADER, width: 480  }),
        celda("NOMBRE COMPLETO", { bold: true, bg: GRIS_HEADER, width: 3600 }),
        celda("DOCUMENTO",   { bold: true, center: true, bg: GRIS_HEADER, width: 1200 }),
        celda("ESTADO",      { bold: true, center: true, bg: GRIS_HEADER, width: 3240 }),
      ),
    ];

    participantes.forEach((p, idx) => {
      const nombre = p.aprendiz?.nombre || "";
      const doc    = p.aprendiz?.documento || "—";
      const rapStatus = p.rapStatus && typeof p.rapStatus === "object" ? p.rapStatus : null;

      let estadoTexto;
      if (rapStatus) {
        const pendientesRaps = Object.entries(rapStatus)
          .filter(([, v]) => v === "PENDIENTE")
          .map(([k]) => k);
        const noParticipoPorRap = Object.values(rapStatus).every(v => v === "NO PARTICIPÓ");
        const todosAprobados   = Object.values(rapStatus).every(v => v === "APROBÓ");
        if (todosAprobados)       estadoTexto = "Aprobó";
        else if (noParticipoPorRap) estadoTexto = "No participó";
        else if (pendientesRaps.length > 0) {
          const rapsNombres = pendientesRaps.map(c => {
            const m = c.match(/-?(\d+)$/);
            return m ? `RAP ${m[1]}` : c;
          }).join(", ");
          estadoTexto = `Evidencias pendientes (${rapsNombres})`;
        } else {
          estadoTexto = "Pendiente";
        }
      } else {
        const j = p.juicio;
        if (j === "APROBÓ")        estadoTexto = "Aprobó";
        else if (j === "PENDIENTE") estadoTexto = "Evidencias pendientes";
        else                        estadoTexto = "No participó";
      }

      partFilas.push(fila(
        celda(String(idx + 1), { center: true }),
        celda(nombre),
        celda(doc, { center: true, size: 16 }),
        celda(estadoTexto, { center: true }),
      ));
    });

    if (participantes.length === 0) {
      partFilas.push(fila(celda("Sin participantes registrados.", { italics: true, span: 4, center: true })));
    }

    const participantesTabla = tabla(partFilas);

    // ── Sección 6: Tabla resumen ───────────────────────────────────────────────
    const resumenTabla = tabla([
      fila(
        celda("TOTAL APRENDICES", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("APROBÓ",           { bold: true, center: true, bg: GRIS_HEADER }),
        celda("EVIDENCIAS PENDIENTES", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("NO PARTICIPÓ",     { bold: true, center: true, bg: GRIS_HEADER }),
      ),
      fila(
        celda(String(participantes.length), { center: true, bold: true, size: 24 }),
        celda(String(nAprobaron),           { center: true, bold: true, size: 24 }),
        celda(String(nPendientes),          { center: true, bold: true, size: 24 }),
        celda(String(nNoParticipo),         { center: true, bold: true, size: 24 }),
      ),
    ]);

    // ── Sección 7: Conclusiones ────────────────────────────────────────────────
    const conclusionesTabla = tabla([
      fila(celda("CONCLUSIONES", { bold: true, center: true, bg: GRIS_HEADER })),
      fila(celda(acta.conclusiones || "Sin conclusiones registradas.", {})),
    ]);

    // ── Sección 8: Nota (llamados de atención) ────────────────────────────────
    const notaItems = [];
    for (const p of participantes) {
      const nombre = (p.aprendiz?.nombre || "").toUpperCase().trim();
      const wc = warningPorNombre.get(nombre) || 0;
      if (wc > 0) {
        notaItems.push(`El/la aprendiz ${p.aprendiz?.nombre} tuvo ${wc} llamado(s) de atención por plataforma.`);
      }
    }
    const notaTexto = notaItems.length > 0
      ? notaItems.join("\n")
      : "Sin llamados de atención registrados en la plataforma.";

    const notaTabla = tabla([
      fila(celda("NOTA", { bold: true, center: true, bg: GRIS_HEADER })),
      fila(celda(notaTexto, { size: 16 })),
    ]);

    // ── Sección 9: Compromisos ─────────────────────────────────────────────────
    const compromisos = Array.isArray(acta.compromisos) ? acta.compromisos : [];
    const compromisosFilas = [
      fila(
        celda("ACTIVIDAD / COMPROMISO", { bold: true, bg: GRIS_HEADER }),
        celda("FECHA",                  { bold: true, center: true, bg: GRIS_HEADER, width: 1500 }),
        celda("RESPONSABLE",            { bold: true, bg: GRIS_HEADER, width: 2400 }),
      ),
    ];
    if (compromisos.length === 0) {
      compromisosFilas.push(fila(celda("Sin compromisos registrados.", { italics: true, span: 3, center: true })));
    } else {
      for (const c of compromisos) {
        compromisosFilas.push(fila(
          celda(c.actividad   || ""),
          celda(c.fecha       || "", { center: true }),
          celda(c.responsable || ""),
        ));
      }
    }
    const compromisosTabla = tabla(compromisosFilas);

    // ── Sección 10: Notas / Aclaraciones (opcional) ─────────────────────────
    const notasAclaraciones = acta.notas ? tabla([
      fila(celda("NOTAS / ACLARACIONES", { bold: true, center: true, bg: GRIS_HEADER })),
      fila(celda(acta.notas, { size: 18 })),
    ]) : null;

    // ── Sección 11: Firma ─────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({
      where:  { id: acta.userId },
      select: { nombre: true },
    });

    const firmaTabla = tabla([
      fila(
        celda("FIRMA INSTRUCTOR DE FORMACIÓN",  { bold: true, center: true, bg: GRIS_HEADER }),
        celda("FIRMA COORDINADOR ACADÉMICO",     { bold: true, center: true, bg: GRIS_HEADER }),
      ),
      fila(
        celda(`\n\n_______________________________\n${user?.nombre || ""}`, { center: true, size: 18 }),
        celda("\n\n_______________________________\n",                        { center: true, size: 18 }),
      ),
    ]);

    // ── Ensamblar documento ─────────────────────────────────────────────────────
    const espacio = parrafo("", { before: 120, after: 0 });

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 1080, right: 1080 },
          },
        },
        children: [
          headerTabla,
          espacio,
          infoTabla,
          espacio,
          objetivoTabla,
          espacio,
          rapsTabla,
          espacio,
          parrafo("REGISTRO DE PARTICIPANTES", { bold: true, center: true, size: 22, before: 80 }),
          participantesTabla,
          espacio,
          parrafo("RESUMEN", { bold: true, center: true, size: 22, before: 80 }),
          resumenTabla,
          espacio,
          conclusionesTabla,
          espacio,
          notaTabla,
          espacio,
          compromisosTabla,
          espacio,
          ...(notasAclaraciones ? [notasAclaraciones, espacio] : []),
          firmaTabla,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `acta-${acta.numero}-gor-f-084.docx`;

    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });
  // ═══════════════════════════════════════════════════════════════════════════
  // FLUJO "NATIVO" — versión nueva en dos pasos: `preview-native` calcula el acta
  // completa SIN persistir (para que el instructor la revise en la UI), y
  // `confirm-native` la crea ya aprobada. Misma lógica de mapeo RAP↔Evidencia que
  // auto-poblar (mismo bloqueador RapEvidenciaRel=0).
  // ═══════════════════════════════════════════════════════════════════════════

  // ── POST /api/actas/preview-native ──────────────────────────────────────────
  fastify.post("/api/actas/preview-native", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId, rapIds } = req.body || {};
    if (!fichaId || !Array.isArray(rapIds) || rapIds.length === 0) {
      return reply.code(400).send({ error: "fichaId y rapIds son requeridos." });
    }

    const ficha = await verificarFichaDelUsuario(fichaId, req.user.id, reply);
    if (!ficha) return;

    // 1. Obtener RAPs
    const rapsInfo = await prisma.rAP.findMany({
      where:  { id: { in: rapIds } },
      select: { id: true, codigo: true },
    });
    const rapCodigoPorId = new Map(rapsInfo.map(r => [r.id, r.codigo]));

    // 2. Evidencias por RAP (confirmadas + IA aceptadas)
    const [relsConfirmadas, relsIA] = await Promise.all([
      prisma.rapEvidenciaRel.findMany({
        where:  { rapId: { in: rapIds }, evidencia: { fichaId } },
        select: { rapId: true, evidenciaId: true },
      }),
      prisma.matchingPropuesta.findMany({
        where:  { rapId: { in: rapIds }, estado: "aceptado", evidencia: { fichaId } },
        select: { rapId: true, evidenciaId: true },
      }),
    ]);

    const mapaRapEvidencias = new Map();
    for (const rel of [...relsConfirmadas, ...relsIA]) {
      if (!mapaRapEvidencias.has(rel.rapId)) mapaRapEvidencias.set(rel.rapId, new Set());
      mapaRapEvidencias.get(rel.rapId).add(rel.evidenciaId);
    }
    const todasEvidenciaIds = [...new Set([...relsConfirmadas, ...relsIA].map(r => r.evidenciaId))];

    // 3. Aprendices
    const aprendicesRaw = await prisma.aprendiz.findMany({
      where:  { fichaId },
      select: { id: true, nombre: true, moodleId: true, _count: { select: { entregas: true } } },
    });
    const aprendicesValidos = filtrarAprendicesValidos(aprendicesRaw);

    function nucleoPrimerToken(nombre) {
      const tok = nombre.split(/\s+/)[0];
      const m = tok.match(/^[A-Z]{2,3}([A-Z].*)$/);
      return m ? m[1] : tok;
    }
    function claveNombre(nombre) {
      const tokens = nombre.trim().split(/\s+/);
      const nucleo = nucleoPrimerToken(nombre);
      const resto  = tokens.slice(1).join(" ").toLowerCase();
      return `${nucleo.toLowerCase()}|${resto}`;
    }

    const grupoDuplicados = new Map();
    for (const a of aprendicesValidos) {
      const k = claveNombre(a.nombre);
      if (!grupoDuplicados.has(k)) grupoDuplicados.set(k, []);
      grupoDuplicados.get(k).push(a);
    }

    const aprendicesFinal = [];
    for (const grupo of grupoDuplicados.values()) {
      if (grupo.length === 1) {
        aprendicesFinal.push(grupo[0]);
      } else {
        grupo.sort((a, b) => {
          const diffEntregas = (b._count.entregas) - (a._count.entregas);
          if (diffEntregas !== 0) return diffEntregas;
          return a.nombre.length - b.nombre.length;
        });
        aprendicesFinal.push(grupo[0]);
      }
    }
    const aprendices = aprendicesFinal.map(a => ({ id: a.id, nombre: a.nombre, moodleId: a.moodleId }));
    const aprendizIds = aprendices.map(a => a.id);

    // ── Validación Mapeo al Vuelo ───────────────────────────────────────────────
    // Detectar RAPs que no tienen evidencias vinculadas para notificar a la UI
    // y evitar el fallback silencioso que dejaba a todos en PENDIENTE.
    const rapsSinEvidencias = [];
    for (const rapId of rapIds) {
      const evidenciasDelRap = mapaRapEvidencias.get(rapId);
      if (!evidenciasDelRap || evidenciasDelRap.size === 0) {
        rapsSinEvidencias.push({
          id: rapId,
          codigo: rapCodigoPorId.get(rapId) || rapId
        });
      }
    }

    if (rapsSinEvidencias.length > 0) {
      return reply.code(422).send({
        error: "RAP_SIN_EVIDENCIAS",
        message: "Hay RAPs seleccionados que no tienen evidencias vinculadas.",
        rapsSinEvidencias
      });
    }

    // Al pasar la validación, garantizamos que todas las evidencias están mapeadas,
    // por ende, el modo siempre será per-RAP.
    const modoPerRap = true;

    // 5. Entregas
    let todasEntregas;
    if (modoPerRap) {
      todasEntregas = await prisma.entrega.findMany({
        where: { aprendizId: { in: aprendizIds }, evidenciaId: { in: todasEvidenciaIds } },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true },
      });
    } else {
      todasEntregas = await prisma.entrega.findMany({
        where: { aprendizId: { in: aprendizIds }, evidencia: { fichaId } },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true },
      });
    }
    const entregasPorAprendiz = new Map();
    for (const e of todasEntregas) {
      if (!entregasPorAprendiz.has(e.aprendizId)) entregasPorAprendiz.set(e.aprendizId, []);
      entregasPorAprendiz.get(e.aprendizId).push(e);
    }

    // Helpers de clasificación viven en ../lib/calificacion (ver auto-poblar).

    // 6. Preview Result
    const participantes = aprendices.map(aprendiz => {
      const entregasAprendiz = entregasPorAprendiz.get(aprendiz.id) ?? [];
      const rapStatus = {};
      let hasUngraded = false;

      if (modoPerRap) {
        const entregasMap = new Map(entregasAprendiz.map(e => [e.evidenciaId, e]));
        for (const rapId of rapIds) {
          const codigo = rapCodigoPorId.get(rapId) ?? rapId;
          const evidIds = mapaRapEvidencias.get(rapId) ?? new Set();
          // Evidencias sin entrega del aprendiz → virtual sin_entregar.
          const entregasDelRap = [...evidIds].map(eid =>
            entregasMap.get(eid) ?? { evidenciaId: eid, estado: "sin_entregar", notaActual: null }
          );
          const r = calcularEstado(entregasDelRap);
          rapStatus[codigo] = r.estado;
          if (r.hasUngraded) hasUngraded = true;
        }
      } else {
        const r = calcularEstado(entregasAprendiz);
        for (const rapId of rapIds) {
          const codigo = rapCodigoPorId.get(rapId) ?? rapId;
          rapStatus[codigo] = r.estado;
        }
        if (r.hasUngraded) hasUngraded = true;
      }

      // JUICIO GENERAL — REGLAS ESTRICTAS (ver lib/calificacion).
      const juicio = calcularJuicio(Object.values(rapStatus));

      return {
        aprendizId: aprendiz.id,
        nombre: aprendiz.nombre,
        moodleId: aprendiz.moodleId,
        juicio,
        rapStatus,
        hasUngraded
      };
    });

    const warningsCount = participantes.filter(p => p.hasUngraded).length;

    return { participantes, warningsCount, modoPerRap };
  });

  // ── POST /api/actas/confirm-native ─────────────────────────────────────────
  fastify.post("/api/actas/confirm-native", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId, numero, fecha, hora, lugar, objetivo, rapIds, participantes } = req.body || {};

    if (!fichaId || !numero || !fecha || !hora || !objetivo || !Array.isArray(rapIds) || !Array.isArray(participantes)) {
      return reply.code(400).send({ error: "Faltan datos requeridos para crear el acta." });
    }

    const ficha = await verificarFichaDelUsuario(fichaId, req.user.id, reply);
    if (!ficha) return;

    // Crear el Acta
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

    // Guardar los participantes
    await prisma.actaParticipante.createMany({
      data: participantes.map(p => ({
        actaId: acta.id,
        aprendizId: p.aprendizId,
        juicio: p.juicio ?? "NO PARTICIPÓ",
        rapStatus: p.rapStatus ?? {},
        hasUngraded: Boolean(p.hasUngraded)
      }))
    });

    return reply.code(201).send({ actaId: acta.id });
  });
}

module.exports = actasRoutes;
