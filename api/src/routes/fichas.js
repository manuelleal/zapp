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

    // ── Orden natural por guía (GA1, GA2, GA3…) y selección opcional ──────────
    // El nombre trae el código "GAx-...-AAy-EVzz"; ordenamos por GA→AA→EV (no
    // alfabético, que mezclaba las guías). Filtros: ?gas=1,2,3 o ?evidenciaIds=...
    const claveGA = (n) => {
      const s = n || "";
      const ga = parseInt((s.match(/GA\s*(\d+)/i) || [])[1] || "999", 10);
      const aa = parseInt((s.match(/AA\s*(\d+)/i) || [])[1] || "99", 10);
      const ev = parseInt((s.match(/EV\s*(\d+)/i) || [])[1] || "99", 10);
      return ga * 10000 + aa * 100 + ev;
    };
    const gaDe = (n) => parseInt((String(n).match(/GA\s*(\d+)/i) || [])[1] || "-1", 10);
    const gasPedidas = String(req.query.gas || "").split(",").map(s => parseInt(s, 10)).filter(x => !isNaN(x));
    const idsPedidos = String(req.query.evidenciaIds || "").split(",").map(s => s.trim()).filter(Boolean);
    let evids = ficha.evidencias;
    if (idsPedidos.length) evids = evids.filter(e => idsPedidos.includes(e.id));
    else if (gasPedidas.length) evids = evids.filter(e => gasPedidas.includes(gaDe(e.nombre)));
    evids.sort((a, b) => claveGA(a.nombre) - claveGA(b.nombre));
    ficha.evidencias = evids;

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Reporte Zajuna");

    // ── Paleta Zajuna (NUESTRA, no la de la Extensión Z) ──────────────────────
    const C = {
      rap:       'FF4F46E5',                       // indigo (encabezado RAP)
      hdrAssign: 'FFE0E7FF', hdrQuiz: 'FFFCE7F3', hdrForum: 'FFD1FAE5', hdrFijo: 'FFF3F4F6',
      okBg:  'FFBBF7D0', okTx:  'FF166534',         // aprobado (verde)
      malBg: 'FFFECACA', malTx: 'FF991B1B',         // reprobado (rojo)
      pendBg:'FFFEF08A', pendTx:'FF854D0E', pendLink:'FF2563EB', // por calificar
      seBg:  'FFE5E7EB', seTx:  'FF6B7280',         // sin entregar
    };
    const borde = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
    const fill = (argb) => ({ type:'pattern', pattern:'solid', fgColor:{ argb } });
    // URL al grader/actividad de Moodle por tipo (links que la Extensión Z NO tiene).
    const urlCalificar = (ev, moodleId) => {
      const cmid = (String(ev.href||"").match(/id=(\d+)/) || [])[1];
      if (!cmid) return null;
      const base = "https://zajuna.sena.edu.co/zajuna/mod";
      if (ev.tipo === "quiz")  return `${base}/quiz/report.php?id=${cmid}&mode=grading`;
      if (ev.tipo === "forum") return `${base}/forum/view.php?id=${cmid}`;
      return `${base}/assign/view.php?id=${cmid}&action=grader${moodleId ? `&userid=${moodleId}` : ""}`;
    };

    const N = ficha.evidencias.length;
    const colAprob = 3 + N; // 1=Aprendiz, 2=Documento, 3..2+N=evidencias, última=Aprobadas

    // Fila 1: RAPs
    const rowRaps = ["Resultados de Aprendizaje (RAP)", ""];
    ficha.evidencias.forEach(ev => rowRaps.push(ev.rapRels.map(r => r.rap.codigo).join("\n") || "Sin RAP"));
    rowRaps.push("");
    const headerRaps = sheet.addRow(rowRaps);
    headerRaps.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    headerRaps.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    headerRaps.eachCell(c => { c.fill = fill(C.rap); c.border = borde; });

    // Fila 2: Encabezados (Aprendiz, Documento, evidencias coloreadas por tipo, Aprobadas)
    const rowEvidencias = ["Aprendiz", "Documento", ...ficha.evidencias.map(ev => ev.nombre), "Aprobadas"];
    const headerEvi = sheet.addRow(rowEvidencias);
    headerEvi.font = { bold: true, size: 9 };
    headerEvi.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    headerEvi.height = 46;
    headerEvi.eachCell((cell, col) => {
      let bg = C.hdrFijo;
      if (col >= 3 && col <= 2 + N) {
        const t = ficha.evidencias[col - 3].tipo;
        bg = t === "quiz" ? C.hdrQuiz : t === "forum" ? C.hdrForum : C.hdrAssign;
      }
      cell.fill = fill(bg); cell.border = borde;
    });

    sheet.getColumn(1).width = 32;
    sheet.getColumn(2).width = 16;
    for (let i = 3; i <= 2 + N; i++) sheet.getColumn(i).width = 13;
    sheet.getColumn(colAprob).width = 11;
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 2 }];
    sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: colAprob } };

    const firstEvLetter = sheet.getColumn(3).letter;
    const lastEvLetter  = sheet.getColumn(2 + N).letter;

    // Filas de Aprendices
    ficha.aprendices.forEach(a => {
      const entregasMap = new Map();
      a.entregas.forEach(ent => entregasMap.set(ent.evidenciaId, ent));

      const row = sheet.addRow([a.nombre, a.documento || ""]);
      row.alignment = { vertical: 'middle' };
      row.font = { size: 9 };
      row.getCell(1).border = borde;
      row.getCell(2).border = borde;
      row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };

      ficha.evidencias.forEach((ev, idx) => {
        const cell = row.getCell(idx + 3);
        const entrega = entregasMap.get(ev.id);
        cell.border = borde;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

        const cual = entrega && entrega.notaCualitativa ? String(entrega.notaCualitativa).toUpperCase() : null;
        const num  = entrega && typeof entrega.notaActual === "number" ? entrega.notaActual : null;
        const tieneNota = cual !== null || num !== null;
        const estadoPend = entrega && (entrega.estado.toLowerCase().includes("calificar") || entrega.estado.toLowerCase().includes("borrador"));

        if (!entrega) {
          cell.value = "SE";                                   // Sin entregar
          cell.fill = fill(C.seBg); cell.font = { color: { argb: C.seTx }, size: 9 };
        } else if (!tieneNota || (estadoPend && !cual)) {
          const url = urlCalificar(ev, a.moodleId);            // Por calificar + link
          if (url) {
            cell.value = { text: "PC ▸", hyperlink: url, tooltip: "Ir a calificar en Zajuna" };
            cell.font = { color: { argb: C.pendLink }, underline: true, bold: true, size: 9 };
          } else {
            cell.value = "PC"; cell.font = { color: { argb: C.pendTx }, bold: true, size: 9 };
          }
          cell.fill = fill(C.pendBg);
        } else {
          const aprob = cual === "A" || (num !== null && num >= 70);   // Calificado
          cell.value = cual !== null ? cual : num;            // número como NÚMERO (para COUNTIF)
          cell.fill = fill(aprob ? C.okBg : C.malBg);
          cell.font = { color: { argb: aprob ? C.okTx : C.malTx }, bold: true, size: 9 };
        }
      });

      // Columna "Aprobadas": fórmula viva (cuenta "A" + numéricas ≥70).
      const r = row.number;
      const rango = `${firstEvLetter}${r}:${lastEvLetter}${r}`;
      const cAprob = row.getCell(colAprob);
      cAprob.value = { formula: `COUNTIF(${rango},"A")+COUNTIF(${rango},">=70")` };
      cAprob.border = borde;
      cAprob.alignment = { horizontal: 'center', vertical: 'middle' };
      cAprob.font = { bold: true, size: 9, color: { argb: C.okTx } };
    });

    // ── Hoja "Leyenda" (algo que la Extensión Z NO tiene) ─────────────────────
    const leg = workbook.addWorksheet("Leyenda");
    leg.getColumn(1).width = 14; leg.getColumn(2).width = 48;
    leg.addRow(["Código", "Significado"]).eachCell(c => { c.font = { bold: true, color:{argb:'FFFFFFFF'} }; c.fill = fill(C.rap); c.border = borde; });
    [
      ["A",    "Aprobado (cualitativa A o nota ≥ 70/100 — umbral SENA)", C.okBg, C.okTx],
      ["D",    "Deficiente / no aprobado (cualitativa D o nota < 70)",    C.malBg, C.malTx],
      ["0-100","Nota numérica (verde si ≥70, rojo si <70)",              C.okBg, C.okTx],
      ["PC ▸", "Por calificar — clic para ir directo al grader de Moodle", C.pendBg, C.pendLink],
      ["SE",   "Sin entregar",                                            C.seBg, C.seTx],
    ].forEach(([cod, sig, bg, tx]) => {
      const lr = leg.addRow([cod, sig]);
      lr.getCell(1).fill = fill(bg); lr.getCell(1).font = { bold: true, color:{argb:tx} };
      lr.getCell(1).alignment = { horizontal:'center' };
      lr.eachCell(c => c.border = borde);
    });
    // Última actualización de datos = el scan más reciente de las entregas de la ficha.
    let maxScan = null;
    for (const ap of ficha.aprendices) for (const e of ap.entregas) {
      if (e.fechaScan && (!maxScan || e.fechaScan > maxScan)) maxScan = e.fechaScan;
    }
    const fmt = (d) => d ? new Date(d).toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" }) : "sin escanear";
    leg.addRow([]);
    const rAct = leg.addRow(["", `Última actualización de los datos: ${fmt(maxScan)}`]);
    rAct.getCell(2).font = { bold: true, color: { argb: C.rap } };
    leg.addRow(["", "Encabezados por tipo: azul = tarea · rosa = cuestionario · verde = foro"]);
    leg.addRow(["", `Generado por Zajuna App — ${new Date().toLocaleDateString("es-CO")}`]);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Reporte_Avanzado_${ficha.codigo}_${new Date().toISOString().slice(0,10)}.xlsx`;

    reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(buffer);
  });
}

module.exports = fichasRoutes;
