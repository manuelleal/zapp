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
const { sanearActa, formatearDocumento } = require("../lib/actaSaneado");
const {
  construirMapaRapEvidencias,
  detectarRapsSinEvidencias,
  inyectarVirtualesSinEntregar,
} = require("./actas.helpers");

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
          // Campos del formato oficial GOR-F-084 V02 (opcionales).
          ciudad:            { type: "string" },
          horaInicio:        { type: "string" },
          horaFin:           { type: "string" },
          direccionRegional: { type: "string" },
          vocera:            { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    const { fichaId, numero, fecha, hora, lugar, objetivo, rapIds,
            ciudad, horaInicio, horaFin, direccionRegional, vocera } = req.body || {};

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
        ciudad:            ciudad || null,
        horaInicio:        horaInicio || null,
        horaFin:           horaFin || null,
        direccionRegional: direccionRegional || null,
        vocera:            vocera || null,
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

    const { conclusiones, compromisos, hora, lugar, objetivo, rapIds, archivada, notas,
            ciudad, horaInicio, horaFin, direccionRegional, vocera } = req.body || {};

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
    if (ciudad            !== undefined) data.ciudad            = ciudad;
    if (horaInicio        !== undefined) data.horaInicio        = horaInicio;
    if (horaFin           !== undefined) data.horaFin           = horaFin;
    if (direccionRegional !== undefined) data.direccionRegional = direccionRegional;
    if (vocera            !== undefined) data.vocera            = vocera;

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

    // Mapa: rapId → Set<evidenciaId> (helper puro en actas.helpers.js)
    const { mapaRapEvidencias, todasEvidenciaIds } = construirMapaRapEvidencias(relsConfirmadas, relsIA);

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
    // (helper puro en actas.helpers.js)
    const rapsSinEvidencias = detectarRapsSinEvidencias(rapIds, mapaRapEvidencias, rapCodigoPorId);

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
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true, notaCualitativa: true },
      });
    } else {
      todasEntregas = await prisma.entrega.findMany({
        where: {
          aprendizId: { in: aprendizIds },
          evidencia:  { fichaId: acta.fichaId },
        },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true, notaCualitativa: true },
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
          // Inyectar virtuales para evidencias sin entrega (helper en actas.helpers.js).
          const entregasDelRap = inyectarVirtualesSinEntregar(evidIds, entregasMap);
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
      Header, Footer, TableLayoutType, ImageRun,
    } = require("docx");
    const fs = require("fs");
    const path = require("path");

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

    // Nombre + código de la competencia (todos los RAPs del acta son de la misma).
    // Se lee del primer RAP → Competencia; cae a ficha.nombre si no se encuentra.
    let competenciaNombre = ficha.nombre || "";
    let competenciaCodigo = "";
    if (rapIds.length > 0) {
      const primerRap = await prisma.rAP.findFirst({
        where:  { id: { in: rapIds } },
        select: { competencia: { select: { nombre: true, codigo: true } } },
      });
      if (primerRap?.competencia?.nombre) competenciaNombre = primerRap.competencia.nombre;
      if (primerRap?.competencia?.codigo) competenciaCodigo = primerRap.competencia.codigo;
    }

    // ── Saneo de textos (determinista + IA best-effort) ────────────────────────
    // Repara datos sucios de extracción ANTES de imprimirlos en el documento
    // institucional: descripción de RAP con basura del PDF, competencia placeholder
    // "[Sin nombre…]", programa como código "P_228118…", typos del objetivo. La IA
    // NO toca juicios académicos (regla #8); si falla, cae al saneo determinista.
    // Ver api/src/lib/actaSaneado.js.
    const saneado = await sanearActa({
      competenciaNombre,
      competenciaCodigo,
      programaNombre: ficha.programa || ficha.nombre || "",
      objetivo:       acta.objetivo || "",
      raps:           rapsInfo.map(r => ({ codigo: r.codigo, descripcion: r.descripcion })),
    });

    // Texto final a imprimir (con fallbacks legibles si el saneo deja algo vacío).
    competenciaNombre = saneado.competenciaNombre || ficha.nombre || "la competencia del programa";
    // Si no hay nombre de programa legible, omitimos el token (no imprimir "—").
    const programaLegible = saneado.programaNombre || "";
    const objetivoLegible = saneado.objetivo || acta.objetivo || "";
    // Descripción saneada por código de RAP, para las tablas/párrafos R1..Rn.
    const descRapPorCodigo = new Map(saneado.raps.map(r => [String(r.codigo), r.descripcion]));

    // ── Conteos / particiones ──────────────────────────────────────────────────
    // El formato GOR-F-084 separa en dos tablas: APROBARON vs PENDIENTES POR
    // EVALUAR. Usamos el juicio general (APROBÓ = aprobó; el resto = por evaluar).
    const aprobaron  = participantes.filter(p => p.juicio === "APROBÓ");
    const porEvaluar = participantes.filter(p => p.juicio !== "APROBÓ");
    const nTotal = participantes.length;

    // ── Helpers de estilo ──────────────────────────────────────────────────────
    const BORDE  = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
    const BORDES = { top: BORDE, bottom: BORDE, left: BORDE, right: BORDE };
    const VERDE_SENA = "39A900";   // verde institucional
    const GRIS_HEADER = "D9D9D9";  // gris claro de encabezados de tabla

    // run(): TextRun con defaults del acta. `nl:true` agrega salto de línea antes.
    const run = (text, o = {}) => new TextRun({
      text: String(text ?? ""), bold: o.bold, italics: o.italics,
      size: o.size || 18, color: o.color, break: o.nl ? 1 : undefined,
    });

    // celda(): contenido = string | TextRun[] (un párrafo) | {paras:[Paragraph]}.
    function celda(contenido, opts = {}) {
      let children;
      if (contenido && Array.isArray(contenido.paras)) {
        children = contenido.paras;
      } else {
        const runs = typeof contenido === "string"
          ? [run(contenido, opts)]
          : (Array.isArray(contenido) ? contenido : [run(contenido, opts)]);
        children = [new Paragraph({
          alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: runs,
        })];
      }
      return new TableCell({
        borders:       BORDES,
        shading:       opts.bg ? { fill: opts.bg } : undefined,
        verticalAlign: VerticalAlign.CENTER,
        columnSpan:    opts.span,
        children,
      });
    }

    const fila = (...celdas) => new TableRow({ children: celdas });

    // tabla(): layout FIJO con anchos por columna en DXA (suman ~10080 = ancho útil
    // en carta con márgenes de 1080). Sin colWidths usa 100% auto.
    function tabla(rows, colWidths) {
      return new Table({
        width:        { size: 100, type: WidthType.PERCENTAGE },
        layout:       colWidths ? TableLayoutType.FIXED : undefined,
        columnWidths: colWidths,
        rows,
      });
    }

    // parr(): párrafo suelto (fuera de tabla). children = string | TextRun[].
    function parr(contenido, opts = {}) {
      return new Paragraph({
        spacing:   { before: opts.before ?? 80, after: opts.after ?? 60 },
        alignment: opts.center ? AlignmentType.CENTER : (opts.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT),
        bullet:    opts.bullet ? { level: 0 } : undefined,
        children:  typeof contenido === "string" ? [run(contenido, { size: opts.size || 20, bold: opts.bold, italics: opts.italics, color: opts.color })] : contenido,
      });
    }

    // Banda de sección a todo el ancho (ej. "DESARROLLO DE LA REUNIÓN").
    const banda = (texto) => tabla([
      fila(celda(texto, { bold: true, center: true, size: 20, bg: GRIS_HEADER })),
    ]);

    const fechaStr = acta.fecha
      ? new Date(acta.fecha).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })
      : "";
    const horaIni = acta.horaInicio || acta.hora || "______";
    const horaFin = acta.horaFin || "______";
    const ciudad  = acta.ciudad || "______";
    const dirReg  = acta.direccionRegional || "______";

    // Etiqueta del estado por RAP en las tablas R1..Rn (formato oficial).
    const etiquetaRap = (estado) => estado === "APROBÓ" ? "APROBADO" : "POR EVALUAR";

    const user = await prisma.user.findUnique({
      where:  { id: acta.userId },
      select: { nombre: true },
    });
    const instructorNombre = user?.nombre || "";
    const espacio = parr("", { before: 80, after: 0 });

    // ════════════════════════════════════════════════════════════════════════════
    // ENCABEZADO (caja superior del formato GOR-F-084 V02). Una tabla de 4 columnas;
    // las filas largas usan span para ocupar todo el ancho.
    // ════════════════════════════════════════════════════════════════════════════
    const labelVal = (label, val, opts = {}) => celda({ paras: [
      new Paragraph({ children: [run(label, { bold: true })] }),
      new Paragraph({ children: [run(val)] }),
    ] }, opts);

    const nombreComite =
      `Seguimiento y Evaluación de la formación ${programaLegible ? programaLegible + " " : ""}FICHA: ${ficha.codigo || ""} ` +
      `en el desarrollo y ejecución de la competencia ${competenciaNombre}`;

    const AGENDA = [
      "1. Verificación del quórum, saludo y bienvenida",
      `2. Informe de Seguimiento Competencia ${competenciaNombre}`,
      "3. Informe de llamados de Atención académicos y/o disciplinarios",
      "4. Informe de seguimiento a la asistencia de los aprendices",
      "5. Novedades",
    ];

    const headerInfoTabla = tabla([
      fila(celda(`ACTA No. ${acta.numero}`, { bold: true, center: true, size: 24, span: 4 })),
      fila(celda({ paras: [
        new Paragraph({ children: [run("NOMBRE DEL COMITÉ O DE LA REUNIÓN:", { bold: true })] }),
        new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [run(nombreComite)] }),
      ] }, { span: 4 })),
      fila(
        celda("CIUDAD Y FECHA:", { bold: true }),
        // Ciudad + fecha juntas (antes la ciudad se leía pero NUNCA se imprimía).
        celda(acta.ciudad ? `${acta.ciudad}, ${fechaStr}` : fechaStr, { bold: true }),
        labelVal("HORA INICIO:", horaIni),
        labelVal("HORA FIN:", horaFin),
      ),
      fila(
        celda("LUGAR Y/O ENLACE:", { bold: true }),
        celda(acta.lugar || "", { bold: true }),
        labelVal("DIRECCIÓN / REGIONAL / CENTRO:", dirReg, { span: 2 }),
      ),
      fila(celda({ paras: [
        new Paragraph({ children: [run("AGENDA O PUNTOS PARA DESARROLLAR:", { bold: true })] }),
        ...AGENDA.map(t => new Paragraph({ children: [run(t)] })),
      ] }, { span: 4 })),
      fila(celda({ paras: [
        new Paragraph({ children: [run("OBJETIVO(S) DE LA REUNIÓN:", { bold: true })] }),
        new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [run(objetivoLegible)] }),
      ] }, { span: 4 })),
    ], [2520, 2520, 2520, 2520]);

    // ════════════════════════════════════════════════════════════════════════════
    // DESARROLLO — verificación del quórum + roster de TODOS los aprendices.
    // ════════════════════════════════════════════════════════════════════════════
    const rosterFilas = [
      fila(
        celda("N°", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("NOMBRE COMPLETO", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("CC/TI", { bold: true, center: true, bg: GRIS_HEADER }),
      ),
    ];
    if (participantes.length === 0) {
      rosterFilas.push(fila(celda("Sin aprendices registrados.", { italics: true, center: true, span: 3 })));
    } else {
      participantes.forEach((p, idx) => rosterFilas.push(fila(
        celda(String(idx + 1), { center: true }),
        celda(p.aprendiz?.nombre || ""),
        celda(formatearDocumento(p.aprendiz?.documento), { center: true, size: 16 }),
      )));
    }
    const rosterTabla = tabla(rosterFilas, [620, 6460, 3000]);

    // ── Tablas R1..Rn (APROBARON / POR EVALUAR) ────────────────────────────────
    const n = rapsInfo.length;
    const nombreW = Math.max(1200, 8080 - 850 * n);
    const colWidthsRaps = [500, nombreW, 1500, ...Array(n).fill(850)];

    function tablaRaps(lista) {
      const head = fila(
        celda("N°", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("NOMBRE COMPLETO", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("CC/TI", { bold: true, center: true, bg: GRIS_HEADER }),
        ...rapsInfo.map((r, i) => celda(`R${i + 1}`, { bold: true, center: true, bg: GRIS_HEADER })),
      );
      const rows = [head];
      if (lista.length === 0) {
        rows.push(fila(celda("Ninguno.", { italics: true, center: true, span: 3 + n })));
      } else {
        lista.forEach((p, idx) => {
          const st = p.rapStatus && typeof p.rapStatus === "object" ? p.rapStatus : {};
          rows.push(fila(
            celda(String(idx + 1), { center: true }),
            celda(p.aprendiz?.nombre || ""),
            celda(formatearDocumento(p.aprendiz?.documento), { center: true, size: 14 }),
            ...rapsInfo.map(r => celda(etiquetaRap(st[r.codigo] ?? st[r.id] ?? "PENDIENTE"), { center: true, size: 14 })),
          ));
        });
      }
      return tabla(rows, colWidthsRaps);
    }

    // ── Resultados de aprendizaje a alcanzar (R1..Rn) ──────────────────────────
    // El rótulo "R{n}" es secuencial (como el formato oficial), pero acompañamos
    // el CÓDIGO real del RAP entre paréntesis para trazabilidad (antes solo decía
    // "R1" y se perdía la referencia, ej. 240202501-06). La descripción viene
    // saneada (sin la basura del PDF) por descRapPorCodigo.
    const rapsParrafos = rapsInfo.length > 0
      ? rapsInfo.map((r, i) => parr([
          run(`R${i + 1} (${r.codigo}). `, { bold: true }),
          run(descRapPorCodigo.get(String(r.codigo)) || r.descripcion || r.codigo),
        ]))
      : [parr("(Sin resultados de aprendizaje asociados a esta acta.)", { italics: true })];

    // ── Llamados de atención (desde mensajes/plataforma) ───────────────────────
    const notaItems = [];
    for (const p of participantes) {
      const wc = warningPorNombre.get((p.aprendiz?.nombre || "").toUpperCase().trim()) || 0;
      if (wc > 0) notaItems.push(`El/la aprendiz ${p.aprendiz?.nombre} registra ${wc} llamado(s) de atención por plataforma.`);
    }
    const llamadosTexto = notaItems.length > 0
      ? notaItems.join(" ")
      : "No se realizaron llamados de Atención académicos y/o disciplinarios a ningún aprendiz.";

    // ── Conclusiones (viñetas desde el texto del acta) ─────────────────────────
    const conclusionesLineas = (acta.conclusiones || "").split("\n").map(s => s.trim()).filter(Boolean);
    const conclusionesParrafos = conclusionesLineas.length > 0
      ? conclusionesLineas.map(t => parr(t, { bullet: true, justify: true }))
      : [parr("Sin conclusiones registradas.", { italics: true })];

    // ── Tabla ACTIVIDAD / DECISIÓN (compromisos) ───────────────────────────────
    const compromisos = Array.isArray(acta.compromisos) ? acta.compromisos : [];
    const actividadFilas = [
      fila(
        celda("ACTIVIDAD / DECISIÓN", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("FECHA", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("RESPONSABLE", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("FIRMA O PARTICIPACIÓN VIRTUAL", { bold: true, center: true, bg: GRIS_HEADER }),
      ),
    ];
    if (compromisos.length === 0) {
      actividadFilas.push(fila(celda("Sin actividades / decisiones registradas.", { italics: true, center: true, span: 4 })));
    } else {
      for (const c of compromisos) actividadFilas.push(fila(
        celda(c.actividad || ""),
        celda(c.fecha || "", { center: true }),
        celda(c.responsable || instructorNombre, { center: true }),
        celda("", {}),
      ));
    }
    const actividadTabla = tabla(actividadFilas, [3500, 1400, 2700, 2480]);

    // ── Tabla ASISTENTES Y APROBACIÓN DECISIONES ───────────────────────────────
    const asistentesFilas = [
      fila(
        celda("NOMBRE", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("DEPENDENCIA / EMPRESA", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("APRUEBA (SI/NO)", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("OBSERVACIÓN", { bold: true, center: true, bg: GRIS_HEADER }),
        celda("FIRMA O PARTICIPACIÓN VIRTUAL", { bold: true, center: true, bg: GRIS_HEADER }),
      ),
      fila(
        celda(instructorNombre, { bold: true, center: true }),
        celda("INSTRUCTOR(A) SENA", { center: true }),
        celda("SI", { center: true }),
        celda("NINGUNA", { center: true }),
        celda("", {}),
      ),
    ];
    if (acta.vocera) {
      asistentesFilas.push(fila(
        celda(acta.vocera, { bold: true, center: true }),
        celda("VOCERO(A) DE LA FORMACIÓN", { center: true }),
        celda("SI", { center: true }),
        celda("NINGUNA", { center: true }),
        celda("", {}),
      ));
    }
    const asistentesTabla = tabla(asistentesFilas, [2400, 2200, 1200, 1800, 2480]);

    const leyTexto =
      "De acuerdo con la Ley 1581 de 2012, Protección de Datos Personales, el Servicio Nacional de Aprendizaje SENA, " +
      "se compromete a garantizar la seguridad y protección de los datos personales que se encuentran almacenados en " +
      "este documento, y les dará el tratamiento correspondiente en cumplimiento de lo establecido legalmente.";

    // ════════════════════════════════════════════════════════════════════════════
    // ENSAMBLAR — logo y "GOR-F-084 V02" se repiten por página vía header/footer.
    // ════════════════════════════════════════════════════════════════════════════
    // Logo SENA oficial: imagen incrustada (api/assets/sena-logo.png). Si el archivo
    // no está, cae al texto "SENA" en verde para no romper la generación.
    let logoHeaderParr;
    try {
      const logoBuf = fs.readFileSync(path.join(__dirname, "../assets/sena-logo.png"));
      logoHeaderParr = new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          data: logoBuf,
          transformation: { width: 70, height: 70 },
        })],
      });
    } catch (_) {
      logoHeaderParr = new Paragraph({ alignment: AlignmentType.CENTER, children: [run("SENA", { bold: true, color: VERDE_SENA, size: 30 })] });
    }

    const doc = new Document({
      sections: [{
        properties: { page: { margin: { top: 720, bottom: 720, left: 1080, right: 1080 } } },
        headers: { default: new Header({ children: [logoHeaderParr] }) },
        footers: { default: new Footer({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run("GOR-F-084 V02", { size: 16 })] }),
        ] }) },
        children: [
          // Nota de revisión SIEMPRE visible: el acta se genera con los datos de la
          // plataforma; lo que falte queda en blanco (campos con "______"). El
          // instructor debe revisarla/completarla antes de firmar y subir. Borrar
          // esta línea antes de la versión final.
          parr(
            "⚠ Borrador generado automáticamente. Revise y complete los datos faltantes (marcados con ______) antes de firmar y subir el acta. Elimine este aviso en la versión final.",
            { center: true, italics: true, color: "C00000", size: 16, before: 0, after: 120 }
          ),
          headerInfoTabla,
          espacio,
          banda("DESARROLLO DE LA REUNIÓN"),
          parr("1. VERIFICACIÓN DEL QUORUM, SALUDO Y BIENVENIDA", { bold: true }),
          parr("Se da inicio a la reunión una vez cumplido el quórum y se verifica la lista de ASISTENTES:"),
          parr(`✓ ${instructorNombre} – Instructor(a) SENA`),
          parr(`✓ APRENDICES ASOCIADOS A LA FICHA ${ficha.codigo || ""}, que se listan a continuación:`, { justify: true }),
          rosterTabla,
          espacio,
          parr(`De los ${nTotal} aprendices asociados a la ficha, ${aprobaron.length} aprobaron satisfactoriamente la competencia y ${porEvaluar.length} quedaron pendientes por evaluar.`, { justify: true }),
          parr("INFORME DE SEGUIMIENTO A LA COMPETENCIA Y EVALUACIÓN DE RESULTADOS DE APRENDIZAJE", { bold: true }),
          parr([run("COMPETENCIA: ", { bold: true }), run(competenciaNombre)], { justify: true }),
          parr("Resultados de Aprendizaje a alcanzar:", { bold: true }),
          ...rapsParrafos,
          espacio,
          parr([run("Los aprendices relacionados a continuación "), run("APROBARON SATISFACTORIAMENTE", { bold: true }), run(" la competencia con sus respectivos resultados de aprendizaje planteados.")], { justify: true }),
          tablaRaps(aprobaron),
          espacio,
          parr([run("Los aprendices relacionados a continuación "), run("QUEDARON PENDIENTES POR EVALUAR", { bold: true }), run(" la competencia con sus respectivos resultados de aprendizaje.")], { justify: true }),
          tablaRaps(porEvaluar),
          espacio,
          parr("2. INFORME DE LLAMADOS DE ATENCIÓN ACADÉMICOS Y/O DISCIPLINARIOS", { bold: true }),
          parr(llamadosTexto, { justify: true }),
          parr("3. INFORME DE SEGUIMIENTO A LA ASISTENCIA DE LOS APRENDICES", { bold: true }),
          parr(`De los ${nTotal} aprendices asociados a la ficha, ${aprobaron.length} culminaron y aprobaron las actividades de la competencia. El detalle de asistencia reposa en el registro anexo.`, { justify: true }),
          espacio,
          banda("CONCLUSIONES"),
          ...conclusionesParrafos,
          espacio,
          actividadTabla,
          espacio,
          banda("ASISTENTES Y APROBACIÓN DECISIONES"),
          asistentesTabla,
          espacio,
          parr(leyTexto, { justify: true, size: 16, italics: true }),
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

    // Mapa: rapId → Set<evidenciaId> (helper puro en actas.helpers.js)
    const { mapaRapEvidencias, todasEvidenciaIds } = construirMapaRapEvidencias(relsConfirmadas, relsIA);

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
    // (helper puro en actas.helpers.js)
    const rapsSinEvidencias = detectarRapsSinEvidencias(rapIds, mapaRapEvidencias, rapCodigoPorId);

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
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true, notaCualitativa: true },
      });
    } else {
      todasEntregas = await prisma.entrega.findMany({
        where: { aprendizId: { in: aprendizIds }, evidencia: { fichaId } },
        select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true, notaCualitativa: true },
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
          // Inyectar virtuales para evidencias sin entrega (helper en actas.helpers.js).
          const entregasDelRap = inyectarVirtualesSinEntregar(evidIds, entregasMap);
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
    const { fichaId, numero, fecha, hora, lugar, objetivo, rapIds, participantes,
            ciudad, horaInicio, horaFin, direccionRegional, vocera } = req.body || {};

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
        ciudad:            ciudad || null,
        horaInicio:        horaInicio || null,
        horaFin:           horaFin || null,
        direccionRegional: direccionRegional || null,
        vocera:            vocera || null,
      },
    });

    // SEGURIDAD (multi-tenant, regla #1): los aprendizId vienen del cliente. Hay que
    // verificar que TODOS pertenezcan a la ficha del acta; si no, se podrían adjuntar
    // aprendices de otra ficha/instructor y sus nombres+documentos saldrían en el Word
    // (fuga de datos personales — la propia acta cita la Ley 1581). Validar antes del
    // createMany (el FK solo exige que el aprendiz exista, no que sea de esta ficha).
    const aprendizIdsPedidos = [...new Set(participantes.map(p => p.aprendizId).filter(Boolean))];
    const aprendicesValidos = await prisma.aprendiz.findMany({
      where:  { fichaId, id: { in: aprendizIdsPedidos } },
      select: { id: true },
    });
    const setValidos = new Set(aprendicesValidos.map(a => a.id));
    const ajenos = aprendizIdsPedidos.filter(id => !setValidos.has(id));
    if (ajenos.length > 0) {
      // Rollback del acta recién creada para no dejar un borrador huérfano.
      await prisma.actaSeguimiento.delete({ where: { id: acta.id } }).catch(() => {});
      return reply.code(403).send({ error: "Algunos aprendices no pertenecen a esta ficha." });
    }

    // Guardar los participantes (solo los ya validados como de la ficha).
    await prisma.actaParticipante.createMany({
      data: participantes
        .filter(p => setValidos.has(p.aprendizId))
        .map(p => ({
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
