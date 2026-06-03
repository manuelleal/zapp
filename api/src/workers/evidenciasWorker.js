require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("../../../scraper/auth");
const { obtenerEvidencias, revisarEntregas, revisarEntregasForo, revisarEntregasQuiz, obtenerMatriculados, descargarGradebookCSV,
        obtenerSesskey, resolverAssignInfo, estadoDesdeParticipante, listarParticipantesBatch } = require("../../../scraper/evidencias");
const { parsearCSV } = require("../../../scraper/csvParser");

// Normaliza una URL de Moodle conservando solo el parámetro ?id=NNN.
// Evita duplicados cuando el Gradebook Tree añade &action=grading u otros extras.
function normalizarHref(href) {
  try {
    const url = new URL(href);
    const id = url.searchParams.get("id");
    if (id) return `${url.origin}${url.pathname}?id=${id}`;
  } catch {}
  return href;
}

const worker = new Worker("evidencias", async (job) => {
  const { jobId, userId, fichaId, courseId, competenciaCodigo, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const savedSession = await loadSession(userId);
  const ctx = await acquireContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(savedSession ? { storageState: savedSession } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      // La sesión expirada redirige a la raíz https://zajuna.sena.edu.co/ (página de login),
      // NO a una ruta /login. Verificamos que la URL esté DENTRO de Moodle (/zajuna/).
      sessionValida = page.url().includes("/zajuna/") && !page.url().includes("/login");
      if (!sessionValida) log("[evidenciasWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
        throw err;
      }
      const state = await ctx.storageState();
      await saveSession(userId, state).catch(e => log(`[evidenciasWorker] no se pudo guardar sesión: ${e.message}`));
    }
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    // CAPA 1 (perf): aquí había un `page.goto(/course/view.php)` + cerrarModal
    // que se eliminó. Era una navegación muerta (~2s, además con waitUntil:"load"
    // que es el más lento): su resultado no se leía y tanto obtenerEvidencias()
    // como obtenerMatriculados() ya navegan y cierran el connection-guard-modal
    // por su cuenta. Moodle no exige visitar el curso para abrir el Gradebook
    // Tree ni el grade report, así que la visita no aportaba nada.
    const evidencias = await obtenerEvidencias(page, courseId);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });

    // Fetchear matriculados SIEMPRE para usarlo como filtro global
    // y eliminar definitivamente a los suspendidos en todas las evidencias.
    let matriculadosCache = [];
    try {
      matriculadosCache = await obtenerMatriculados(page, courseId);
    } catch (e) {
      console.error(`[evidenciasWorker] no se pudo fetchear matriculados: ${e.message}`);
    }
    const matriculadosIds = new Set(matriculadosCache.map(m => m.moodleUserId));

    // FAST-SYNC CSV: Descargar y parsear el libro de calificaciones para corregir errores del HTML
    let gradebook = [];
    try {
      const csvText = await descargarGradebookCSV(page, courseId);
      if (csvText) {
        gradebook = parsearCSV(csvText);
        log(`[evidenciasWorker] Gradebook CSV parseado: ${gradebook.length} filas`);
      }
    } catch (e) {
      console.error(`[evidenciasWorker] Error procesando Gradebook CSV: ${e.message}`);
    }

    // Crear mapa rápido Documento -> Fila del Gradebook
    // Como el scraper de evidencias extrae matriculados (que tienen documento/ID Number), lo usamos.
    // También creamos un mapa Nombre -> Fila del Gradebook como fallback.
    const csvByDocumento = new Map();
    const csvByNombre = new Map();
    
    // Nombres de columnas posibles para Documento y Nombre
    let colDocumento = null;
    let colNombre = null;
    
    if (gradebook.length > 0) {
      const headers = Object.keys(gradebook[0]);
      colDocumento = headers.find(h => /número de documento|id number|identificación/i.test(h));
      colNombre = headers.find(h => /nombre completo|full name/i.test(h));
      
      for (const fila of gradebook) {
        if (colDocumento && fila[colDocumento]) {
          csvByDocumento.set(fila[colDocumento].trim().replace(/[.\s-]/g, ""), fila);
        }
        if (colNombre && fila[colNombre]) {
          csvByNombre.set(fila[colNombre].toUpperCase().trim(), fila);
        }
      }
    }

    // =========================================================================
    // FASE 1: DISCOVERY
    // Registrar TODAS las evidencias encontradas en la BD, sin raspar entregas.
    // =========================================================================
    log(`[evidenciasWorker] Fase 1: Discovery de ${evidencias.length} evidencias...`);
    for (const ev of evidencias) {
      // Normalizar href: conservar solo ?id=NNN para evitar duplicados
      // cuando Gradebook Tree añade &action=grading u otros parámetros extra.
      const href = normalizarHref(ev.href);
      await prisma.evidencia.upsert({
        where:  { fichaId_href: { fichaId, href } },
        // itemid solo si el tree lo expuso (no pisar un cache previo con null).
        update: { nombre: ev.texto, tipo: ev.tipo, ...(ev.itemid != null ? { itemid: ev.itemid } : {}) },
        create: { fichaId, nombre: ev.texto, href, tipo: ev.tipo, itemid: ev.itemid ?? null },
      });
    }

    // =========================================================================
    // FASE 2: SCAN (Solo Activas)
    // Extraer de DB las que el instructor activó y raspar las entregas.
    // =========================================================================
    const activas = await prisma.evidencia.findMany({
      where: { fichaId, activaParaScan: true, cerradaAt: null }
    });
    
    log(`[evidenciasWorker] Fase 2: Escaneando entregas de ${activas.length} evidencias activas...`);

    if (activas.length === 0) {
      log(`[evidenciasWorker] ⚠ Sin evidencias activas para ficha ${fichaId}. Actívalas desde la UI (interruptor "Activa para scan") antes de escanear.`);
      await prisma.job.update({
        where: { id: jobId },
        data:  { status: "done", progreso: 100, resultado: { fichaId, evidencias: [], advertencia: "Sin evidencias activas — actívalas desde la UI" } },
      });
      return;
    }

    // =========================================================================
    // CAPA 1 (perf): pre-cargar TODOS los aprendices de la ficha en 1 sola query.
    // Antes se hacía un prisma.aprendiz.upsert() por alumno y por evidencia
    // (p.ej. 30 alumnos × 50 evidencias = 1500 upserts secuenciales). Ahora
    // cargamos el universo una vez y resolvemos en memoria con un Map nombre→aprendiz.
    // Los que falten se crean en lote (createMany) la primera vez que aparecen.
    // =========================================================================
    const aprendicesDb = await prisma.aprendiz.findMany({
      where:  { fichaId },
      select: { id: true, nombre: true, moodleId: true, documento: true },
    });
    const aprendizPorNombre = new Map(aprendicesDb.map(a => [a.nombre, a]));

    // =========================================================================
    // CAPA 2 (perf): leer las entregas de los `assign` activos vía AJAX EN LOTE,
    // en vez de navegar+raspar el DOM de cada uno (lo lento de la Fase 2).
    //   1) sesskey de la sesión Moodle.
    //   2) resolver y CACHEAR el assignId de los assigns que aún no lo tengan
    //      (lectura única del grader HTML, concurrencia limitada).
    //   3) 1 POST batch a mod_assign_list_participants → estado de TODOS de una.
    // Si algo falla (sin sesskey, assignId irresoluble, batch caído), cada assign
    // cae automáticamente al scraper DOM (revisarEntregas) dentro del loop.
    // =========================================================================
    const sesskey = await obtenerSesskey(page).catch(() => null);
    const entregasAjaxPorCmid = new Map(); // cmid → Array<entrega> ya mapeadas

    const activosAssign = activas
      .filter(e => e.tipo === "assign")
      .map(e => ({ ev: e, cmid: (e.href.match(/[?&]id=(\d+)/) || [])[1] }))
      .filter(x => x.cmid);

    if (sesskey && activosAssign.length > 0) {
      // (2) Resolver assignId faltantes con concurrencia limitada (~5 a la vez).
      const porResolver = activosAssign.filter(x => x.ev.assignId == null);
      log(`[evidenciasWorker] CAPA 2: ${activosAssign.length} assigns activos, ${porResolver.length} sin assignId cacheado`);
      const LIMITE = 5;
      for (let i = 0; i < porResolver.length; i += LIMITE) {
        const lote = porResolver.slice(i, i + LIMITE);
        await Promise.all(lote.map(async (x) => {
          const info = await resolverAssignInfo(page, x.cmid).catch(() => ({ assignId: null, contextId: null }));
          if (info.assignId) {
            x.ev.assignId  = info.assignId;
            x.ev.contextId = info.contextId ?? null;
            // Cache persistente: solo se resuelve una vez por evidencia.
            await prisma.evidencia.update({
              where: { id: x.ev.id },
              data:  { assignId: info.assignId, contextId: info.contextId ?? null },
            }).catch(() => {});
          }
        }));
      }

      // (3) Batch list_participants para los assigns que ya tengan assignId.
      const conAssign = activosAssign
        .filter(x => x.ev.assignId != null)
        .map(x => ({ cmid: x.cmid, assignId: x.ev.assignId }));
      try {
        const mapa = await listarParticipantesBatch(page, sesskey, conAssign);
        for (const x of activosAssign) {
          const r = mapa.get(x.cmid);
          if (r && r.participantes) {
            entregasAjaxPorCmid.set(x.cmid, r.participantes.map(p => ({
              nombre:           (p.fullname || `Aprendiz ${p.id}`).substring(0, 70),
              aprendizMoodleId: p.id != null ? String(p.id) : null,
              estado:           estadoDesdeParticipante(p),
            })));
          }
        }
        log(`[evidenciasWorker] CAPA 2: estado AJAX obtenido para ${entregasAjaxPorCmid.size}/${activosAssign.length} assigns`);
      } catch (e) {
        log(`[evidenciasWorker] CAPA 2: batch falló (${e.message}) → fallback DOM en todos`);
      }
    } else if (!sesskey) {
      log(`[evidenciasWorker] CAPA 2: sin sesskey → todos los assign usan DOM`);
    }

    const resumen = [];

    for (let i = 0; i < activas.length; i++) {
      const evDb = activas[i];
      // Necesitamos el actId extrayéndolo de la URL para pasarlo a revisarEntregas
      const m = evDb.href.match(/[?&]id=(\d+)/);
      const actId = m ? m[1] : null;

      if (!actId) continue;

      // --- Obtener entregas según el tipo de actividad ---
      let entregas;
      if (evDb.tipo === "forum") {
        entregas = await revisarEntregasForo(page, actId, courseId, matriculadosCache);
      } else if (evDb.tipo === "quiz") {
        entregas = await revisarEntregasQuiz(page, actId, courseId, matriculadosCache);
      } else {
        // CAPA 2: assign → usar el estado del batch AJAX si lo tenemos; si no
        // (no se resolvió assignId o el AJAX falló), caer al scraper DOM clásico.
        const ajax = entregasAjaxPorCmid.get(actId);
        entregas = ajax ? ajax : await revisarEntregas(page, actId);
      }

      // Aplicar filtro de suspendidos si tenemos matriculados válidos
      if (matriculadosIds.size > 0) {
        entregas = entregas.filter(e => matriculadosIds.has(e.aprendizMoodleId));
      }

      // OVERRIDE CON CSV: localizar la columna del Gradebook que corresponde a
      // esta evidencia. El CSV es la FUENTE DE VERDAD de la nota: el HTML de
      // Moodle a veces muestra "sin calificar" aunque el libro ya tenga la nota.
      let colEvidencia = null;
      if (gradebook.length > 0) {
        // Buscar la columna cuyo nombre contenga el texto de la evidencia (o viceversa)
        const headers = Object.keys(gradebook[0]);
        const limpiar = s => s.toLowerCase().replace(/[.\-_:()]+/g, " ").replace(/\s+/g, " ").trim();
        const evTextoLimpio = limpiar(evDb.nombre);
        colEvidencia = headers.find(h => {
          const hLimpio = limpiar(h);
          return hLimpio.includes(evTextoLimpio) || evTextoLimpio.includes(hLimpio);
        });
      }

      // =====================================================================
      // CAPA 1 (perf): resolución de entregas EN LOTE.
      //   Paso A — crear de golpe los aprendices que aún no existen (createMany).
      //   Paso B — pre-cargar en 1 query las entregas previas de esta evidencia
      //            (en vez de un findUnique por alumno).
      //   Paso C — acumular create/update/historial y ejecutarlos en lote
      //            (createMany + $transaction) en vez de 3 queries por alumno.
      // =====================================================================

      // --- Paso A: aprendices faltantes → createMany (1 insert en lote) ---
      const nuevosAprendices = [];
      const encolados = new Set(); // evita encolar 2 veces el mismo nombre
      for (const entrega of entregas) {
        if (aprendizPorNombre.has(entrega.nombre) || encolados.has(entrega.nombre)) continue;
        encolados.add(entrega.nombre);
        nuevosAprendices.push({
          fichaId,
          nombre:   entrega.nombre,
          moodleId: entrega.aprendizMoodleId || null,
        });
      }
      if (nuevosAprendices.length > 0) {
        await prisma.aprendiz.createMany({ data: nuevosAprendices, skipDuplicates: true });
        // createMany NO devuelve los registros: recargamos solo los recién creados
        // para conocer sus IDs y meterlos al Map en memoria.
        const recargados = await prisma.aprendiz.findMany({
          where:  { fichaId, nombre: { in: nuevosAprendices.map(a => a.nombre) } },
          select: { id: true, nombre: true, moodleId: true, documento: true },
        });
        for (const a of recargados) aprendizPorNombre.set(a.nombre, a);
      }

      // --- Paso B: entregas previas de esta evidencia (1 query) ---
      const entregasPrevias = await prisma.entrega.findMany({ where: { evidenciaId: evDb.id } });
      const entregaPorAprendiz = new Map(entregasPrevias.map(e => [e.aprendizId, e]));

      // --- Paso C: acumular operaciones para ejecutarlas en lote ---
      const aprendizUpdates  = []; // refrescar moodleId de aprendices existentes
      const entregaCreates   = []; // → createMany
      const entregaUpdates   = []; // → $transaction de prisma.entrega.update
      const historialCreates = []; // → createMany de HistorialEstado
      const yaConCreate      = new Set(); // evita 2 creates de entrega para el mismo aprendiz

      let pendientes  = 0;
      let calificados = 0;
      let sinEntregar = 0;

      for (const entrega of entregas) {
        const aprendizDb = aprendizPorNombre.get(entrega.nombre);
        if (!aprendizDb) continue; // tras el Paso A no debería faltar ninguno

        // Refrescar moodleId si el scraper lo trae y en DB faltaba o cambió.
        if (entrega.aprendizMoodleId && aprendizDb.moodleId !== entrega.aprendizMoodleId) {
          aprendizUpdates.push(
            prisma.aprendiz.update({ where: { id: aprendizDb.id }, data: { moodleId: entrega.aprendizMoodleId } })
          );
          aprendizDb.moodleId = entrega.aprendizMoodleId; // mantener el Map al día
        }

        // --- APLICAR CORRECCIÓN FAST-SYNC CSV (la nota del libro manda) ---
        if (colEvidencia) {
           let csvFila = null;
           // Intentar buscar por documento primero (si lo tenemos en el aprendiz)
           if (aprendizDb.documento) {
              csvFila = csvByDocumento.get(aprendizDb.documento);
           }
           // Fallback a nombre
           if (!csvFila) {
              csvFila = csvByNombre.get(entrega.nombre.toUpperCase().trim());
           }

           if (csvFila) {
              const valorCSV = csvFila[colEvidencia];
              if (valorCSV && valorCSV.trim() !== "" && valorCSV.trim() !== "-") {
                 const limpio = valorCSV.trim().toLowerCase();
                 // Ignorar valores explícitos de "sin calificar" o pendientes de Moodle
                 if (limpio !== "no calificado" && limpio !== "pendient" && limpio !== "-999") {
                    entrega.estado = "calificado";
                    const num = parseFloat(valorCSV);
                    if (!isNaN(num)) {
                       entrega.notaActual = num;
                    }
                 }
              }
           }
        }

        // --- Diff contra lo que ya hay en DB (sin findUnique: usamos el Map) ---
        const entregaExistente = entregaPorAprendiz.get(aprendizDb.id);

        if (!entregaExistente) {
          // Guardar para createMany. yaConCreate evita violar @@unique
          // ([evidenciaId, aprendizId]) si el scraper repitiera el mismo aprendiz.
          if (!yaConCreate.has(aprendizDb.id)) {
            yaConCreate.add(aprendizDb.id);
            entregaCreates.push({
              evidenciaId:  evDb.id,
              aprendizId:   aprendizDb.id,
              estado:       entrega.estado,
              moodlePostId: entrega.moodlePostId || null,
              notaActual:   entrega.notaActual ?? null,
            });
          }
        } else {
          const estadoCambio = entregaExistente.estado !== entrega.estado;
          // notaCambio: la nota del CSV difiere de lo que ya tenemos en DB
          const notaCambio = entrega.notaActual != null && entregaExistente.notaActual !== entrega.notaActual;
          if (estadoCambio) {
            historialCreates.push({
              entregaId:      entregaExistente.id,
              estadoAnterior: entregaExistente.estado,
              estadoNuevo:    entrega.estado,
            });
          }
          if (estadoCambio || notaCambio || entrega.moodlePostId) {
            entregaUpdates.push(
              prisma.entrega.update({
                where: { id: entregaExistente.id },
                data:  {
                  ...(estadoCambio ? { estado: entrega.estado } : {}),
                  // fechaScan se refresca cuando cambia estado O nota, no solo estado
                  ...((estadoCambio || notaCambio) ? { fechaScan: new Date() } : {}),
                  ...(entrega.moodlePostId ? { moodlePostId: entrega.moodlePostId } : {}),
                  ...(notaCambio ? { notaActual: entrega.notaActual } : {}),
                },
              })
            );
          }
        }

        if (entrega.estado === "pendiente")    pendientes++;
        else if (entrega.estado === "calificado")  calificados++;
        else if (entrega.estado === "sin_entregar") sinEntregar++;
      }

      // Ejecutar todo en el mínimo de round-trips posible (en vez de ~3 por alumno).
      if (entregaCreates.length)   await prisma.entrega.createMany({ data: entregaCreates });
      if (historialCreates.length) await prisma.historialEstado.createMany({ data: historialCreates });
      if (aprendizUpdates.length || entregaUpdates.length) {
        await prisma.$transaction([...aprendizUpdates, ...entregaUpdates]);
      }

      // Reset calificandoAt si el instructor marcó "calificando" pero Zajuna
      // sigue mostrando pendientes — vuelve al estado visual normal.
      if (pendientes > 0 && evDb.calificandoAt) {
        await prisma.evidencia.update({ where: { id: evDb.id }, data: { calificandoAt: null } });
      }

      // Cierre/reapertura es 100% manual desde la UI: no tocamos cerradaAt aqui.
      // Razon: pendientes=0 puede deberse a evidencias con fechas viejas, no a
      // que esten realmente revisadas. El instructor decide.

      resumen.push({
        nombre:     evDb.nombre,
        href:       evDb.href,
        pendientes,
        calificados,
        sinEntregar,
        total:      entregas.length,
      });

      const progreso = Math.round(50 + ((i + 1) / (activas.length || 1)) * 40);
      await prisma.job.update({ where: { id: jobId }, data: { progreso } });
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { fichaId, evidencias: resumen } },
    });

  } finally {
    await releaseContext(ctx);
  }

}, { connection, concurrency: 3 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
