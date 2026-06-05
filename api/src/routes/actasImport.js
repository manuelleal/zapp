const prisma = require("../db/client");
const { parsearCSVActa } = require("../../../scraper/csvParser");

async function actasImportRoutes(fastify) {

  // ── POST /api/actas/import-csv/preview ──────────────────────────────────────
  // Parsea el CSV y retorna el resultado clasificado SIN escribir en DB.
  // Body: multipart con campo "csv" (archivo .csv o texto plano) y "fichaId"
  fastify.post("/api/actas/import-csv/preview", {
    preHandler: fastify.authenticate,
    config:     { rawBody: true },
  }, async (req, reply) => {
    let csvText = "";
    let fichaId = "";

    // Leer el body — acepta multipart o texto plano
    const ct = req.headers["content-type"] || "";

    if (ct.includes("multipart/form-data")) {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "Se requiere un archivo CSV en el campo 'csv'." });
      const buf = await data.toBuffer();
      csvText = buf.toString("utf8");
      fichaId = req.body?.fichaId || data.fields?.fichaId?.value || "";
    } else if (ct.includes("application/json")) {
      csvText = req.body?.csv || "";
      fichaId = req.body?.fichaId || "";
    } else {
      return reply.code(400).send({ error: "Content-Type no soportado. Usar multipart/form-data o application/json con { csv, fichaId }." });
    }

    if (!csvText.trim()) return reply.code(400).send({ error: "CSV vacío." });

    // Parsear y clasificar
    const resultado = parsearCSVActa(csvText);

    // Enriquecer con warning_count desde MensajeFormativo si hay fichaId
    if (fichaId) {
      try {
        const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
        if (ficha && ficha.userId === req.user.id) {
          const warningData = await prisma.$queryRaw`
            SELECT
              elem->>'aprendizId' AS aprendiz_id,
              a.nombre,
              COUNT(*)::int AS warning_count
            FROM "MensajeFormativo" mf,
                 jsonb_array_elements(mf.destinatarios) AS elem
            JOIN "Aprendiz" a ON a.id = elem->>'aprendizId'
            WHERE mf."fichaId" = ${fichaId}
              AND mf.estado = 'enviado'
            GROUP BY elem->>'aprendizId', a.nombre
          `;

          // Crear mapa nombre → warningCount (el CSV no tiene aprendizId)
          const warningPorNombre = new Map(
            warningData.map(w => [
              (w.nombre || "").toUpperCase().trim(),
              Number(w.warning_count),
            ])
          );

          for (const fila of resultado.filas) {
            const key = fila.nombre.toUpperCase().trim();
            fila.warningCount = warningPorNombre.get(key) || 0;
          }
        }
      } catch (_) {
        // warning_count queda en 0 — no crítico
      }
    }

    return {
      filas:               resultado.filas,
      resumen:             resultado.resumen,
      errores:             resultado.errores,
      columnasDetectadas:  resultado.columnasDetectadas,
    };
  });

  // ── POST /api/actas/:id/import-csv ──────────────────────────────────────────
  // Confirma el import: upsert Aprendiz (con documento) + upsert ActaParticipante.
  // Body: { filas: [...] } — el array clasificado retornado por /preview
  fastify.post("/api/actas/:id/import-csv", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type:     "object",
        required: ["filas"],
        properties: {
          filas: { type: "array" },
        },
      },
    },
  }, async (req, reply) => {
    const { filas } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return reply.code(400).send({ error: "filas debe ser un array no vacío." });
    }

    // Verificar que el acta pertenece al usuario
    const acta = await prisma.actaSeguimiento.findUnique({ where: { id: req.params.id } });
    if (!acta)                    return reply.code(404).send({ error: "Acta no encontrada." });
    if (acta.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta acta." });

    let importados = 0;
    const erroresImport = [];

    for (const fila of filas) {
      if (!fila.nombre || typeof fila.nombre !== "string") continue;

      try {
        // Upsert Aprendiz (clave única: fichaId + nombre)
        const aprendiz = await prisma.aprendiz.upsert({
          where:  { fichaId_nombre: { fichaId: acta.fichaId, nombre: fila.nombre } },
          create: { fichaId: acta.fichaId, nombre: fila.nombre, documento: fila.documento || null },
          update: fila.documento ? { documento: fila.documento } : {},
        });

        // Mapear estado a juicio
        let juicio = "PENDIENTE";
        if (fila.estado === "Aprobó")              juicio = "APROBÓ";
        else if (fila.estado === "No participó")    juicio = "NO PARTICIPÓ";
        else if (fila.estado?.startsWith("Evidencias pendientes")) juicio = "EVIDENCIAS PENDIENTES";

        // Upsert ActaParticipante
        await prisma.actaParticipante.upsert({
          where:  { actaId_aprendizId: { actaId: acta.id, aprendizId: aprendiz.id } },
          create: { actaId: acta.id, aprendizId: aprendiz.id, juicio },
          update: { juicio },
        });

        importados++;
      } catch (e) {
        erroresImport.push(`${fila.nombre}: ${e.message}`);
      }
    }

    return reply.code(200).send({ importados, errores: erroresImport });
  });
}

module.exports = actasImportRoutes;
