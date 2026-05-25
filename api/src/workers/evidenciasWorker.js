require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("../../../scraper/auth");
const { obtenerEvidencias, revisarEntregas, revisarEntregasForo, revisarEntregasQuiz, obtenerMatriculados, descargarGradebookCSV } = require("../../../scraper/evidencias");
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
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
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

    await page.goto(`${BASE_URL}/course/view.php?id=${courseId}`, { waitUntil: "load", timeout: TIMEOUT });
    await cerrarModal(page);

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
        update: { nombre: ev.texto, tipo: ev.tipo },
        create: { fichaId, nombre: ev.texto, href, tipo: ev.tipo },
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

    const resumen = [];

    for (let i = 0; i < activas.length; i++) {
      const evDb = activas[i];
      // Necesitamos el actId extrayéndolo de la URL para pasarlo a revisarEntregas
      const m = evDb.href.match(/[?&]id=(\d+)/);
      const actId = m ? m[1] : null;

      if (!actId) continue;

      let entregas;
      if (evDb.tipo === "forum") {
        entregas = await revisarEntregasForo(page, actId, courseId, matriculadosCache);
      } else if (evDb.tipo === "quiz") {
        entregas = await revisarEntregasQuiz(page, actId, courseId, matriculadosCache);
      } else {
        entregas = await revisarEntregas(page, actId);
      }

      // Aplicar filtro de suspendidos si tenemos matriculados válidos
      if (matriculadosIds.size > 0) {
        entregas = entregas.filter(e => matriculadosIds.has(e.aprendizMoodleId));
      }

      // OVERRIDE CON CSV: Buscar columna correspondiente a esta evidencia
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

      let pendientes  = 0;
      let calificados = 0;
      let sinEntregar = 0;

      for (const entrega of entregas) {
        // Upsert aprendiz (actualiza moodleId si viene del scraper)
        const aprendizDb = await prisma.aprendiz.upsert({
          where:  { fichaId_nombre: { fichaId, nombre: entrega.nombre } },
          update: entrega.aprendizMoodleId ? { moodleId: entrega.aprendizMoodleId } : {},
          create: { fichaId, nombre: entrega.nombre, moodleId: entrega.aprendizMoodleId || null },
        });

        // APLICAR CORRECCIÓN FAST-SYNC CSV
        if (colEvidencia) {
           let csvFila = null;
           // Intentar buscar por documento primero (si lo tenemos en matriculadosCache)
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

        // Upsert entrega con historial si el estado cambió
        const entregaExistente = await prisma.entrega.findUnique({
          where: { evidenciaId_aprendizId: { evidenciaId: evDb.id, aprendizId: aprendizDb.id } },
        });

        if (!entregaExistente) {
          await prisma.entrega.create({
            data: {
              evidenciaId:  evDb.id,
              aprendizId:   aprendizDb.id,
              estado:       entrega.estado,
              moodlePostId: entrega.moodlePostId || null,
              notaActual:   entrega.notaActual ?? null,
            },
          });
        } else {
          const estadoCambio = entregaExistente.estado !== entrega.estado;
          // notaCambio: la nota del CSV difiere de lo que ya tenemos en DB
          const notaCambio = entrega.notaActual != null && entregaExistente.notaActual !== entrega.notaActual;
          if (estadoCambio) {
            await prisma.historialEstado.create({
              data: {
                entregaId:      entregaExistente.id,
                estadoAnterior: entregaExistente.estado,
                estadoNuevo:    entrega.estado,
              },
            });
          }
          if (estadoCambio || notaCambio || entrega.moodlePostId) {
            await prisma.entrega.update({
              where: { id: entregaExistente.id },
              data:  {
                ...(estadoCambio ? { estado: entrega.estado } : {}),
                // fechaScan se refresca cuando cambia estado O nota, no solo estado
                ...((estadoCambio || notaCambio) ? { fechaScan: new Date() } : {}),
                ...(entrega.moodlePostId ? { moodlePostId: entrega.moodlePostId } : {}),
                ...(notaCambio ? { notaActual: entrega.notaActual } : {}),
              },
            });
          }
        }

        if (entrega.estado === "pendiente")    pendientes++;
        else if (entrega.estado === "calificado")  calificados++;
        else if (entrega.estado === "sin_entregar") sinEntregar++;
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
    await browser.close();
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
