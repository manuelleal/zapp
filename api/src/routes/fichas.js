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
      seBg:  'FFE5E7EB', seTx:  'FF6B7280',         // no entregó
      nsBg:  'FFF8FAFC', nsTx:  'FF94A3B8',         // sin escanear / sin dato (—)
      // Estados finos (plan 010): subestado de Moodle (assigns) + estado de foros.
      draftBg:'FFFED7AA', draftTx:'FF9A3412',       // borrador (naranja): empezó pero no envió
      reabBg: 'FFFBCFE8', reabTx: 'FF9D174D',       // reabierto (rosa): Moodle reopened (no es reenvío confirmado)
      foroPendBg:'FFCFFAFE', foroPendTx:'FF155E75', // foro pendiente de revisar (cian)
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

    // ── Detección de "sin escanear" ───────────────────────────────────────────
    // Una evidencia sin NINGUNA entrega en toda la ficha = nunca se escaneó (no es
    // que nadie entregó: simplemente no hay dato). El instructor debe escanear antes
    // de fiarse del reporte; por eso lo avisamos explícito (antes salía "SE" y se
    // confundía con "no entregó").
    const entregasPorEvid = new Map();
    ficha.aprendices.forEach(a => a.entregas.forEach(e =>
      entregasPorEvid.set(e.evidenciaId, (entregasPorEvid.get(e.evidenciaId) || 0) + 1)));
    const evidsSinEscanear = ficha.evidencias.filter(ev => !(entregasPorEvid.get(ev.id) > 0)).length;
    const hayQueEscanear = ficha.aprendices.length === 0 || evidsSinEscanear > 0;

    // ── Fila 1: Título + aviso de escaneo (a todo el ancho) ───────────────────
    const tituloTxt = `Reporte de evidencias — Ficha ${ficha.codigo}`
      + (hayQueEscanear
          ? `   ⚠ HAY EVIDENCIAS SIN ESCANEAR (marcadas “—”). Escanea la ficha en Helper (botón “Escanear”) para ver el estado real antes de usar este reporte.`
          : "");
    const rowTitulo = sheet.addRow([tituloTxt]);
    sheet.mergeCells(1, 1, 1, colAprob);
    rowTitulo.height = hayQueEscanear ? 30 : 20;
    rowTitulo.getCell(1).fill = fill(hayQueEscanear ? 'FFFEF3C7' : C.rap);
    rowTitulo.getCell(1).font = { bold: true, size: 11, color: { argb: hayQueEscanear ? 'FF92400E' : 'FFFFFFFF' } };
    rowTitulo.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

    // ── Fila 2: Banda de agrupación por GUÍA (GA1, GA2…) ──────────────────────
    // Las evidencias ya vienen ordenadas por GA→AA→EV; aquí agrupamos visualmente
    // las columnas de cada guía con una celda combinada "Guía N" (lo que pidió el
    // instructor: ver el reporte organizado por guía).
    const rowGA = sheet.addRow(new Array(colAprob).fill(""));
    rowGA.height = 18;
    sheet.mergeCells(2, 1, 2, 2);
    sheet.getCell(2, 1).value = "Guía →";
    sheet.getCell(2, 1).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
    sheet.getCell(2, 1).alignment = { horizontal: 'right', vertical: 'middle' };
    const gaColors = ['FFDBEAFE', 'FFEDE9FE', 'FFDCFCE7', 'FFFEF9C3', 'FFFFE4E6', 'FFE0F2FE'];
    let gi = 0, k = 0;
    while (k < N) {
      const ga = gaDe(ficha.evidencias[k].nombre);
      let j = k; while (j < N && gaDe(ficha.evidencias[j].nombre) === ga) j++;
      const cStart = 3 + k, cEnd = 3 + j - 1;
      if (cEnd > cStart) sheet.mergeCells(2, cStart, 2, cEnd);
      const cg = sheet.getCell(2, cStart);
      cg.value = ga >= 0 ? `Guía ${ga}` : "Otras";
      cg.fill = fill(gaColors[gi % gaColors.length]);
      cg.font = { bold: true, size: 9, color: { argb: 'FF374151' } };
      cg.alignment = { horizontal: 'center', vertical: 'middle' };
      cg.border = borde;
      gi++; k = j;
    }

    // ── Fila 3: RAPs ──────────────────────────────────────────────────────────
    const rowRaps = ["Resultados de Aprendizaje (RAP)", ""];
    ficha.evidencias.forEach(ev => rowRaps.push(ev.rapRels.map(r => r.rap.codigo).join("\n") || "Sin RAP"));
    rowRaps.push("");
    const headerRaps = sheet.addRow(rowRaps);
    headerRaps.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    headerRaps.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    headerRaps.eachCell(c => { c.fill = fill(C.rap); c.border = borde; });

    // ── Fila 4: Encabezados (Aprendiz, Documento, evidencias por tipo, Aprobadas) ─
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
    for (let i = 3; i <= 2 + N; i++) sheet.getColumn(i).width = 15;
    sheet.getColumn(colAprob).width = 11;
    // Congela las 2 primeras columnas (nombre+documento) y las 4 filas de cabecera.
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 4 }];
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: colAprob } };

    const firstEvLetter = sheet.getColumn(3).letter;
    const lastEvLetter  = sheet.getColumn(2 + N).letter;

    // Filas de Aprendices
    ficha.aprendices.forEach(a => {
      const entregasMap = new Map();
      a.entregas.forEach(ent => entregasMap.set(ent.evidenciaId, ent));

      // Limpia el "cc"/"ti" que Moodle pega al final del documento (ej. "79451297cc").
      const docLimpio = String(a.documento || "").replace(/\s*(cc|ti|ce|pep|ppt)\s*$/i, "").trim();
      const row = sheet.addRow([a.nombre, docLimpio]);
      row.alignment = { vertical: 'middle' };
      row.font = { size: 9 };
      row.getCell(1).border = borde;
      row.getCell(2).border = borde;
      row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };

      let aprobadas = 0;
      ficha.evidencias.forEach((ev, idx) => {
        const cell = row.getCell(idx + 3);
        const entrega = entregasMap.get(ev.id);
        cell.border = borde;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

        const cual = entrega && entrega.notaCualitativa ? String(entrega.notaCualitativa).toUpperCase() : null;
        const num  = entrega && typeof entrega.notaActual === "number" ? entrega.notaActual : null;
        const tieneNota = cual !== null || num !== null;
        const est = entrega ? String(entrega.estado || "").toLowerCase() : null;
        // "sin_entregar" = el aprendiz NO subió nada (no hay envío que calificar).
        const noEntrego = est != null && (est.includes("sin_entreg") || est.includes("no_entreg") || est.includes("sin entregar"));
        // subestado fino de Moodle (plan 010): "draft"/"reopened"/null. Solo lo traen
        // los assigns; foros/quiz vienen null. Sirve para distinguir "borrador" y "reabierto".
        const sube = entrega ? String(entrega.subestado || "").toLowerCase() : null;

        // Link directo a la evidencia del aprendiz en Zajuna (grader con su userid).
        // Va en TODAS las celdas para revisar/rectificar cualquier estado: si el
        // aprendiz pregunta "profe, ¿por qué perdí?", clic y abres su entrega.
        const url = urlCalificar(ev, a.moodleId);
        const poner = (texto, bg, tx, bold) => {
          cell.value = url
            ? { text: String(texto), hyperlink: url, tooltip: "Abrir esta evidencia del aprendiz en Zajuna" }
            : texto;
          cell.fill = fill(bg);
          cell.font = { color: { argb: tx }, bold: !!bold, size: 9, underline: url ? true : undefined };
        };

        // Precedencia: sin dato → no entregó → nota (lo importante para el acta) →
        // foro (pendiente de revisar / revisado) → borrador → reabierto → por calificar.
        // La nota gana sobre borrador/reabierto: si ya está calificado se ve la nota;
        // los estados finos solo aparecen cuando aún NO hay nota (aportan info real).
        if (!entrega) {
          poner("—", C.nsBg, C.nsTx, false);                 // Sin escanear / sin dato
        } else if (noEntrego) {
          poner("NE", C.seBg, C.seTx, false);                // No entregó
        } else if (tieneNota) {
          const aprob = cual === "A" || (num !== null && num >= 70);
          // Si además hay un borrador/reabierto nuevo, se marca junto a la nota
          // ("A ·BD" / "85 ·RE"): el instructor decidió ver AMBOS (la nota manda,
          // pero el estado fino igual se señala — coherente con el badge de la UI).
          const marca = sube === "draft" ? " ·BD" : sube === "reopened" ? " ·RE" : "";
          poner(`${cual !== null ? cual : num}${marca}`, aprob ? C.okBg : C.malBg, aprob ? C.okTx : C.malTx, true);
          if (aprob) aprobadas++;
        } else if (ev.tipo === "forum") {
          // Foros (plan 009/010): no se califican con nota en la app — se revisan en
          // Moodle. "pendiente" = hay aporte sin revisar; cualquier otro estado = revisado.
          if (est === "pendiente") poner("FP", C.foroPendBg, C.foroPendTx, true);  // Foro pendiente de revisar
          else                     poner("RV", C.okBg, C.okTx, false);             // Revisado
        } else if (sube === "draft") {
          poner("BD", C.draftBg, C.draftTx, true);           // Borrador: empezó pero no envió
        } else if (sube === "reopened") {
          poner("RE", C.reabBg, C.reabTx, true);             // Reabierto (Moodle reopened)
        } else {
          poner("PC ▸", C.pendBg, C.pendLink, true);         // Entregó, por calificar
        }
      });

      // Columna "Aprobadas": conteo en JS (las notas ahora son hyperlinks de texto,
      // así que COUNTIF ya no aplicaría — A cualitativa o nota numérica ≥ 70).
      const cAprob = row.getCell(colAprob);
      cAprob.value = aprobadas;
      cAprob.border = borde;
      cAprob.alignment = { horizontal: 'center', vertical: 'middle' };
      cAprob.font = { bold: true, size: 9, color: { argb: C.okTx } };
    });

    // ── Hoja "Leyenda" (algo que la Extensión Z NO tiene) ─────────────────────
    const leg = workbook.addWorksheet("Leyenda");
    leg.getColumn(1).width = 14; leg.getColumn(2).width = 48;
    leg.addRow(["Código", "Significado"]).eachCell(c => { c.font = { bold: true, color:{argb:'FFFFFFFF'} }; c.fill = fill(C.rap); c.border = borde; });
    [
      ["A",    "Aprobado (cualitativa A o nota ≥ 70/100 — umbral SENA)",   C.okBg, C.okTx],
      ["D",    "Deficiente / no aprobado (cualitativa D o nota < 70)",     C.malBg, C.malTx],
      ["0-100","Nota numérica (verde si ≥70, rojo si <70)",               C.okBg, C.okTx],
      ["PC ▸", "Por calificar — el aprendiz SÍ entregó; clic para ir al grader de Moodle", C.pendBg, C.pendLink],
      ["BD",   "Borrador — el aprendiz empezó la entrega pero NO la envió en Moodle",       C.draftBg, C.draftTx],
      ["RE",   "Reabierto — Moodle reabrió el intento (no es un reenvío confirmado)",       C.reabBg, C.reabTx],
      ["FP",   "Foro pendiente — hay aporte sin revisar (los foros se revisan en Moodle)",  C.foroPendBg, C.foroPendTx],
      ["RV",   "Revisado — foro sin aportes pendientes de revisar",                         C.okBg, C.okTx],
      ["NE",   "No entregó — el aprendiz no subió ninguna evidencia",      C.seBg, C.seTx],
      ["—",    "Sin escanear — no hay datos; escanea la ficha en Helper",  C.nsBg, C.nsTx],
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
    leg.addRow(["", "Una nota seguida de ·BD o ·RE indica que, además de la nota, el aprendiz tiene un borrador o un intento reabierto nuevo en Moodle."]);
    leg.addRow(["", "Encabezados por tipo: azul = tarea · rosa = cuestionario · verde = foro"]);
    leg.addRow(["", "💡 Cada celda de evidencia es un enlace: clic para abrir esa entrega del aprendiz en Zajuna (revisar o rectificar la nota)."]);
    leg.addRow(["", `Generado por Helper — ${new Date().toLocaleDateString("es-CO")}`]);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Reporte_Avanzado_${ficha.codigo}_${new Date().toISOString().slice(0,10)}.xlsx`;

    reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(buffer);
  });
}

module.exports = fichasRoutes;
