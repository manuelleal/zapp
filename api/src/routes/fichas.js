const prisma = require("../db/client");
const { fichasQueue } = require("../lib/queue");

async function fichasRoutes(fastify) {
  // POST /api/fichas/scan — inicia scraping y retorna jobId
  fastify.post("/api/fichas/scan", { preHandler: fastify.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return reply.code(404).send({ error: "Usuario no encontrado." });

    const job = await prisma.job.create({
      data: { userId: user.id, tipo: "fichas", status: "queued" },
    });

    await fichasQueue.add("scan", {
      jobId:            job.id,
      userId:           user.id,
      zajunaUserEnc:    user.zajunaUserEnc,
      zajunaPassEnc:    user.zajunaPassEnc,
      competenciaCodigo: user.competenciaCodigo,
    });

    return reply.code(202).send({ jobId: job.id });
  });

  // POST /api/fichas — crear ficha manualmente
  fastify.post("/api/fichas", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { codigo, courseId, nombre, programa } = req.body || {};
    if (!codigo || !courseId) return reply.code(400).send({ error: "codigo y courseId requeridos." });
    if (isNaN(parseInt(courseId, 10))) return reply.code(400).send({ error: "courseId debe ser un número entero." });

    const existing = await prisma.ficha.findUnique({
      where: { userId_codigo: { userId: req.user.id, codigo: String(codigo) } },
    });
    if (existing) return reply.code(409).send({ error: "Ya existe una ficha con ese código." });

    const ficha = await prisma.ficha.create({
      data: {
        userId:   req.user.id,
        codigo:   String(codigo),
        courseId: parseInt(courseId, 10),
        nombre:   nombre || "",
        programa: programa || "",
      },
    });
    return reply.code(201).send({ id: ficha.id, codigo: ficha.codigo, courseId: ficha.courseId });
  });

  // PUT /api/fichas/:id — editar ficha
  fastify.put("/api/fichas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.id } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const { codigo, nombre, programa, courseId } = req.body || {};
    if (courseId !== undefined && isNaN(parseInt(courseId, 10))) {
      return reply.code(400).send({ error: "courseId debe ser un número entero." });
    }
    const updated = await prisma.ficha.update({
      where: { id: ficha.id },
      data: {
        ...(codigo   ? { codigo }             : {}),
        ...(nombre   !== undefined ? { nombre }   : {}),
        ...(programa !== undefined ? { programa } : {}),
        ...(courseId ? { courseId: parseInt(courseId, 10) } : {}),
      },
    });
    return { id: updated.id, codigo: updated.codigo, nombre: updated.nombre, programa: updated.programa };
  });

  // DELETE /api/fichas/:id — eliminar ficha (solo si no tiene evidencias con entregas)
  fastify.delete("/api/fichas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({
      where:   { id: req.params.id },
      include: { evidencias: { include: { entregas: { take: 1 } } } },
    });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const tieneEntregas = ficha.evidencias.some(ev => ev.entregas.length > 0);
    if (tieneEntregas) return reply.code(409).send({ error: "No se puede eliminar: la ficha tiene entregas registradas." });

    await prisma.ficha.delete({ where: { id: ficha.id } });
    return { ok: true };
  });

  // GET /api/fichas — fichas guardadas en DB para el usuario
  // Query: ?incluirArchivadas=1 para ver tambien las archivadas
  fastify.get("/api/fichas", { preHandler: fastify.authenticate }, async (req) => {
    const incluirArchivadas = req.query?.incluirArchivadas === "1";

    const where = { userId: req.user.id };
    if (!incluirArchivadas) where.archivedAt = null;

    const fichas = await prisma.ficha.findMany({
      where,
      orderBy: [{ archivedAt: "asc" }, { codigo: "asc" }],
      include: {
        evidencias: {
          where:   { cerradaAt: null },
          select:  { entregas: { select: { estado: true } } },
        },
      },
    });

    // Conteo de archivadas (siempre, para que la UI pueda dar pista
    // "todas estan archivadas, activa Ver archivadas")
    const archivadasCount = await prisma.ficha.count({
      where: { userId: req.user.id, archivedAt: { not: null } },
    });

    return {
      archivadasCount,
      fichas: fichas.map(f => {
        let pendientes    = 0;
        let totalEntregas = 0;
        for (const ev of f.evidencias) {
          for (const e of ev.entregas) {
            totalEntregas++;
            if (e.estado === "pendiente") pendientes++;
          }
        }
        return {
          id:               f.id,
          codigo:           f.codigo,
          nombre:           f.nombre,
          courseId:         f.courseId,
          programa:         f.programa,
          archivedAt:       f.archivedAt,
          // null = ficha jamas escaneada (sin entregas en DB)
          pendientes:       totalEntregas === 0 ? null : pendientes,
          tieneCodigoFicha: true,
        };
      }),
      otrosCursos: [],
    };
  });
  // GET /api/fichas/:id/reporte-pendientes — genera un reporte CSV tipo semáforo
  fastify.get("/api/fichas/:id/reporte-pendientes", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({
      where: { id: req.params.id },
      include: {
        evidencias: { orderBy: { nombre: "asc" } },
        aprendices: { orderBy: { nombre: "asc" }, include: { entregas: true } }
      }
    });

    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    // Armar la matriz CSV
    const evidencias = ficha.evidencias;
    const aprendices = ficha.aprendices;

    // Fila 1: Cabeceras
    const header = ["Aprendiz", ...evidencias.map(e => `"${e.nombre.replace(/"/g, '""')}"`)];
    const rows = [header.join(",")];

    for (const a of aprendices) {
      const entregasMap = new Map();
      for (const ent of a.entregas) {
        entregasMap.set(ent.evidenciaId, ent);
      }

      const row = [`"${a.nombre.replace(/"/g, '""')}"`];
      
      for (const ev of evidencias) {
        const entrega = entregasMap.get(ev.id);
        if (!entrega) {
          row.push('"Sin entregar"');
        } else if (entrega.estado.toLowerCase().includes("calificar") || entrega.notaActual === null) {
          row.push('"Por calificar (P)"');
        } else {
          row.push(`"Calificado: ${entrega.notaActual}"`);
        }
      }
      rows.push(row.join(","));
    }

    const csvContent = "\uFEFF" + rows.join("\n"); // \uFEFF para BOM de Excel UTF-8
    const filename = `Reporte_Zajuna_${ficha.codigo}_${new Date().toISOString().slice(0,10)}.csv`;

    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Type", "text/csv; charset=utf-8")
      .send(csvContent);
  });
  // GET /api/fichas/:id/reporte-excel — genera un reporte interactivo en Excel (Mejor que V2 Z)
  fastify.get("/api/fichas/:id/reporte-excel", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({
      where: { id: req.params.id },
      include: {
        evidencias: {
          orderBy: { nombre: "asc" },
          include: { rapRels: { include: { rap: true } } }
        },
        aprendices: { orderBy: { nombre: "asc" }, include: { entregas: true } }
      }
    });

    if (!ficha) return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Reporte Zajuna");

    // Fila 1: RAPs
    const rowRaps = ["Resultados de Aprendizaje (RAP)"];
    ficha.evidencias.forEach(ev => {
      const raps = ev.rapRels.map(r => r.rap.codigo).join("\n");
      rowRaps.push(raps || "Sin RAP");
    });
    const headerRaps = sheet.addRow(rowRaps);
    headerRaps.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRaps.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    headerRaps.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    // Fila 2: Evidencias
    const rowEvidencias = ["Aprendiz"];
    ficha.evidencias.forEach(ev => {
      rowEvidencias.push(ev.nombre);
    });
    const headerEvi = sheet.addRow(rowEvidencias);
    headerEvi.font = { bold: true };
    headerEvi.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    headerEvi.height = 40;
    headerEvi.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    sheet.getColumn(1).width = 35;
    for (let i = 2; i <= rowEvidencias.length; i++) {
      sheet.getColumn(i).width = 25;
    }
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

    // Filas de Aprendices
    ficha.aprendices.forEach(a => {
      const rowData = [a.nombre];
      
      const entregasMap = new Map();
      a.entregas.forEach(ent => entregasMap.set(ent.evidenciaId, ent));

      const row = sheet.addRow(rowData);
      row.alignment = { vertical: 'middle' };
      row.getCell(1).border = { left: { style: 'thin' }, right: { style: 'thin' }, bottom: { style: 'thin' } };

      ficha.evidencias.forEach((ev, idx) => {
        const colIndex = idx + 2;
        const cell = row.getCell(colIndex);
        const entrega = entregasMap.get(ev.id);

        cell.border = { left: { style: 'thin' }, right: { style: 'thin' }, bottom: { style: 'thin' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

        if (!entrega) {
          cell.value = "Sin entregar";
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; // Gris claro
          cell.font = { color: { argb: 'FF6B7280' } };
        } else if (entrega.estado.toLowerCase().includes("calificar") || entrega.estado.toLowerCase().includes("borrador") || entrega.notaActual === null) {
          cell.value = "Por calificar (P)";
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } }; // Amarillo claro
          cell.font = { color: { argb: 'FF854D0E' }, bold: true };
          
          // Crear link al grader
          let cmid = null;
          if (ev.href) {
            const match = ev.href.match(/id=(\d+)/);
            if (match) cmid = match[1];
          }
          if (cmid && a.moodleId && ev.tipo === "assign") {
            const gradeUrl = `https://zajuna.sena.edu.co/zajuna/mod/assign/view.php?id=${cmid}&action=grader&userid=${a.moodleId}`;
            cell.value = { text: "Por calificar (Ir)", hyperlink: gradeUrl, tooltip: "Clic para calificar en Zajuna" };
            cell.font = { color: { argb: 'FF2563EB' }, underline: true, bold: true };
          }
        } else {
          // Ya está calificado. Usar la nota A/D o numérica.
          const notaLetra = entrega.notaCualitativa || entrega.notaActual;
          cell.value = `Calificado: ${notaLetra}`;
          
          if (String(notaLetra).toUpperCase() === "A" || (typeof notaLetra === "number" && notaLetra >= 70)) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBBF7D0' } }; // Verde claro
            cell.font = { color: { argb: 'FF166534' } };
          } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } }; // Rojo claro
            cell.font = { color: { argb: 'FF991B1B' } };
          }
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Reporte_Avanzado_${ficha.codigo}_${new Date().toISOString().slice(0,10)}.xlsx`;

    reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(buffer);
  });
}

module.exports = fichasRoutes;
