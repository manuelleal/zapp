const { BASE_URL, TIMEOUT, log, cerrarModal } = require("./auth");

async function obtenerEvidencias(page, competenciaCodigo) {
  log(`Buscando actividades con código ${competenciaCodigo}...`);

  // Expandir secciones colapsadas que contengan el código
  const cabeceras = page.locator("a, span").filter({ hasText: "Actividad de aprendizaje" });
  const nCab = await cabeceras.count();
  for (let i = 0; i < nCab; i++) {
    const cab = cabeceras.nth(i);
    const texto = (await cab.textContent().catch(() => "")).trim();
    if (!texto.includes(competenciaCodigo)) continue;
    const expandida = await cab.evaluate(el => {
      const li = el.closest("li");
      return li ? !li.classList.contains("collapsed") : true;
    }).catch(() => true);
    if (!expandida) {
      await cab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  const links = await page.$$eval(
    "a",
    (as, codigo) =>
      as
        .filter(a => {
          const href = a.href || "";
          const txt  = (a.textContent || "").trim();
          const esActividad = href.includes("/mod/assign/") || href.includes("/mod/forum/");
          return (
            esActividad &&
            txt.includes(codigo) &&
            !/cuestionario|quiz/i.test(txt) &&
            !/borrador|draft/i.test(txt)
          );
        })
        .map(a => {
          const m    = a.href.match(/[?&]id=(\d+)/);
          const tipo = a.href.includes("/mod/forum/") ? "forum" : "assign";
          return {
            texto: (a.textContent || "").replace(/\s+/g, " ").trim(),
            href:  a.href,
            actId: m ? m[1] : null,
            tipo,
          };
        })
        .filter(l => l.actId !== null),
    competenciaCodigo
  );

  // Deduplicar por href
  const vistos = new Set();
  const unicos = links.filter(l => {
    if (vistos.has(l.href)) return false;
    vistos.add(l.href);
    return true;
  });

  log(`Evidencias encontradas: ${unicos.length}`);
  return unicos;
}

async function revisarEntregas(page, actId) {
  const url = `${BASE_URL}/mod/assign/view.php?id=${actId}&action=grading`;
  log(`Revisando entregas: ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  // Mostrar todos si hay paginación
  const selectPP = page.locator('select[name="perpage"]');
  if (await selectPP.isVisible({ timeout: 2000 }).catch(() => false)) {
    const opts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select[name="perpage"] option'))
        .map(o => ({ val: o.value, n: parseInt(o.value) || 0 }))
    );
    const max = opts.reduce((best, o) => (o.n > best.n ? o : best), opts[0]);
    await selectPP.selectOption(max.val);
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  await page.waitForSelector(".generaltable tbody tr", { timeout: 10_000 }).catch(() => {});

  const filas = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".generaltable tbody tr"));
    return rows
      .filter(row => row.querySelector("td.cell.c0"))
      .map(row => {
        const cols = Array.from(row.querySelectorAll("td.cell"))
          .map(td => (td.textContent || "").replace(/\s+/g, " ").trim());
        const profileLink = row.querySelector('a[href*="/user/profile.php?id="]');
        const aprendizMoodleId = profileLink
          ? ((profileLink.href.match(/[?&]id=(\d+)/) || [])[1] || null)
          : null;
        return { cols, aprendizMoodleId };
      });
  });

  const entregas = [];
  for (const { cols, aprendizMoodleId } of filas) {
    if (cols.length < 3) continue;
    const nombre = (cols[2] || "").substring(0, 70);
    if (nombre.length < 3) continue;

    const estadoTexto = cols[5] || "";
    let estado = "desconocido";
    if (/sin entrega|no submission|no entregado|no ha entregado|reabierto|reopened/i.test(estadoTexto)) {
      estado = "sin_entregar";
    } else if (/calificado|graded/i.test(estadoTexto) && !/sin calificar|not graded/i.test(estadoTexto)) {
      estado = "calificado";
    } else if (/enviado|entregado|submitted|para calificar/i.test(estadoTexto)) {
      estado = "pendiente";
    }

    entregas.push({ nombre, aprendizMoodleId, estado });
  }

  log(`Aprendices encontrados: ${entregas.length}`);
  return entregas;
}

/**
 * Obtiene la lista de participantes/calificaciones de un FORO desde el grade report del curso.
 * Equivalente a revisarEntregas() pero para mod_forum.
 * @param {import('playwright').Page} page
 * @param {string} actId   — cmId del foro
 * @param {number|string} courseId
 * @param {string} nombreForo  — nombre de la evidencia (para fallback de búsqueda de columna)
 */
async function revisarEntregasForo(page, actId, courseId, nombreForo) {
  const url = `${BASE_URL}/grade/report/grader/index.php?id=${courseId}&perpage=0`;
  log(`[foro] Grade report: ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  const resultado = await page.evaluate((actId, nombreForo) => {
    // ─── Paso 1: encontrar el grade item ID de este foro ───────────────────────
    // Los encabezados de columna tienen id="c{gradeItemId}" y un <a> con href al foro
    let gradeItemId = null;

    const thHeaders = Array.from(document.querySelectorAll("th[id]"));
    for (const th of thHeaders) {
      if (!/^c\d+$/.test(th.id)) continue; // solo columnas de items de calificación
      const link = th.querySelector("a[href]");
      if (link && link.href.includes(`/mod/forum/`) && link.href.includes(`id=${actId}`)) {
        gradeItemId = th.id.slice(1); // quitar la "c" inicial
        break;
      }
      // Fallback: comparar por nombre de actividad
      if (!gradeItemId && nombreForo) {
        const textoTh = (th.textContent || "").replace(/\s+/g, " ").trim();
        if (textoTh && nombreForo.startsWith(textoTh.substring(0, 25))) {
          gradeItemId = th.id.slice(1);
        }
      }
    }

    if (!gradeItemId) {
      return { error: `Columna para foro actId=${actId} no encontrada en grade report`, entregas: [] };
    }

    // ─── Paso 2: extraer calificaciones por estudiante ─────────────────────────
    // Las celdas tienen id="u{moodleUserId}c{gradeItemId}"
    const entregas = [];
    const pattern  = new RegExp(`^u(\\d+)c${gradeItemId}$`);

    const celdas = Array.from(document.querySelectorAll(`td[id]`));
    for (const td of celdas) {
      const m = td.id.match(pattern);
      if (!m) continue;
      const moodleUserId = m[1];

      const row = td.closest("tr");
      if (!row) continue;

      // Nombre del aprendiz: en el th[scope="row"] de la misma fila
      const nameTh = row.querySelector('th[scope="row"], th.userfield');
      if (!nameTh) continue;
      const nombre = (nameTh.textContent || "").replace(/\s+/g, " ").trim();
      if (nombre.length < 3) continue;

      // Calificación: span.gradevalue, input, o texto directo
      const gradeSpan = td.querySelector(".gradevalue, .grade");
      const inputEl   = td.querySelector("input[name^='grade[']");
      let gradeText = "";
      if (inputEl)   gradeText = (inputEl.value || "").trim();
      else if (gradeSpan) gradeText = (gradeSpan.textContent || "").trim();
      else gradeText = (td.textContent || "").trim();

      // Mapear al sistema A/D/vacío → calificado / sin_entregar
      // No hay "pendiente" en foros: o tiene calificación o no
      const calificado = gradeText && gradeText !== "-" && gradeText !== "" && gradeText !== " ";
      const estado     = calificado ? "calificado" : "sin_entregar";

      entregas.push({ nombre, aprendizMoodleId: moodleUserId, estado });
    }

    return { entregas, gradeItemId };
  }, actId, nombreForo);

  if (resultado.error) {
    log(`[foro] ⚠️  ${resultado.error}`);
    return [];
  }

  log(`[foro] ${resultado.entregas.length} aprendices (gradeItemId=${resultado.gradeItemId})`);
  return resultado.entregas;
}

module.exports = { obtenerEvidencias, revisarEntregas, revisarEntregasForo };
