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
    if (/sin entrega|no submission|no entregado|no ha entregado/i.test(estadoTexto)) {
      estado = "sin_entregar";
    } else if (/calificado|graded/i.test(estadoTexto) && !/sin calificar|not graded/i.test(estadoTexto)) {
      estado = "calificado";
    } else if (/borrador|draft|reabierto|reopened|enviado|entregado|submitted|para calificar/i.test(estadoTexto)) {
      // Sprint 2.5 opción B: 'borrador (no enviado)' y 'reabierto' caen como pendiente
      // (atención del instructor) en lugar de sin_entregar.
      estado = "pendiente";
    }

    entregas.push({ nombre, aprendizMoodleId, estado });
  }

  log(`Aprendices encontrados: ${entregas.length}`);
  return entregas;
}

/**
 * Extrae datos de posts (autor + rating) en la página actual.
 * Funciona tanto en /mod/forum/view.php (foros tipo blog) como en
 * /mod/forum/discuss.php (cualquier tipo).
 *
 * @returns {Promise<Array<{moodleUserId: string, nombre: string, ratingVal: string|null, ratingText: string|null, postId: string|null}>>}
 */
async function extraerPostsForo(page) {
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const forms = Array.from(document.querySelectorAll('form.postratingform, form[id^="postrating"]'));

    for (const form of forms) {
      const rateduserid = form.querySelector('input[name="rateduserid"]')?.value || null;
      if (!rateduserid || seen.has(rateduserid)) continue;
      seen.add(rateduserid);

      const itemid = form.querySelector('input[name="itemid"]')?.value || null;

      // Selector de calificación (puede ser <select> o <input>)
      const ratingEl = form.querySelector('select[name="rating"], input[name="rating"]');
      let ratingVal  = null;
      let ratingText = null;
      if (ratingEl) {
        ratingVal = ratingEl.value;
        if (ratingEl.tagName === "SELECT" && ratingEl.selectedIndex >= 0) {
          ratingText = (ratingEl.options[ratingEl.selectedIndex].textContent || "").trim();
        }
      }

      // Autor: buscar en el <article> contenedor del post (puede o no contener el form)
      let nombre = null;
      const article =
        form.closest('article[data-post-id], .forumpost, [data-region="post"]') ||
        (itemid ? document.querySelector(`article[data-post-id="${itemid}"], #p${itemid}`) : null);
      if (article) {
        const a = article.querySelector(
          `a[href*="/user/view.php?id=${rateduserid}"], a[href*="/user/profile.php?id=${rateduserid}"]`
        ) || article.querySelector('header a[href*="/user/view.php"], header a[href*="/user/profile"]');
        if (a) nombre = (a.textContent || "").replace(/\s+/g, " ").trim();
      }
      // Fallback global por id en el href
      if (!nombre) {
        const a = document.querySelector(
          `a[href*="/user/view.php?id=${rateduserid}"], a[href*="/user/profile.php?id=${rateduserid}"]`
        );
        if (a) nombre = (a.textContent || "").replace(/\s+/g, " ").trim();
      }

      out.push({ moodleUserId: rateduserid, nombre, ratingVal, ratingText, postId: itemid });
    }

    return out;
  });
}

/**
 * Revisa entregas de un foro de Moodle (Sprint 2.5).
 *
 * Estrategia:
 *  1. Ir a /mod/forum/view.php?id={actId}.
 *  2. Si la vista contiene forms `postratingform` (foros tipo blog / single)
 *     → extraer posts+ratings directamente.
 *  3. Si no, iterar cada discussion (`discuss.php?d=X`) y agregar sus posts.
 *  4. Cruzar con los matriculados (grade report) para marcar `sin_entregar`.
 *
 * Estados:
 *  - `calificado`: el <select name="rating"> tiene valor numerico (no `-999`).
 *  - `pendiente`:  el alumno publicó pero sin calificación (valor `-999` o vacío).
 *  - `sin_entregar`: matriculado en el curso pero sin post.
 *
 * @param {import('playwright').Page} page
 * @param {string|number} actId    — cmId del foro
 * @param {string|number} courseId
 * @returns {Promise<Array<{nombre: string, aprendizMoodleId: string, estado: string}>>}
 */
/**
 * Lee la lista de matriculados del curso desde el grade report.
 * Sprint 2.6 FIX E: util independiente para cachear entre evidencias del mismo scan.
 *
 * @param {import('playwright').Page} page
 * @param {string|number} courseId
 * @returns {Promise<Array<{ moodleUserId: string, nombre: string }>>}
 */
async function obtenerMatriculados(page, courseId) {
  const url = `${BASE_URL}/grade/report/grader/index.php?id=${courseId}&perpage=0`;
  log(`[matriculados] GET ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll(
      'th[scope="row"] a[href*="/user/view.php?id="], th.userfield a[href*="/user/view.php?id="], th[scope="row"] a[href*="/user/profile.php?id="]'
    ));
    const map = new Map();
    for (const a of links) {
      const m = a.href.match(/[?&]id=(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (map.has(id)) continue;
      const nombre = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (nombre.length < 3) continue;
      map.set(id, { moodleUserId: id, nombre });
    }
    return Array.from(map.values());
  });
}

async function revisarEntregasForo(page, actId, courseId, matriculadosCache) {
  const viewUrl = `${BASE_URL}/mod/forum/view.php?id=${actId}`;
  log(`[foro] View: ${viewUrl}`);
  await page.goto(viewUrl, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  // Recolectar posts de la vista (foros tipo blog/single los muestran aquí)
  let posts = await extraerPostsForo(page);
  log(`[foro] Posts en view.php: ${posts.length}`);

  // Si no hay posts en la vista, iterar cada discussion
  if (posts.length === 0) {
    const discussIds = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]').forEach((a) => {
        const m = a.href.match(/[?&]d=(\d+)/);
        if (m) ids.add(m[1]);
      });
      return Array.from(ids);
    });
    log(`[foro] Discussions detectadas: ${discussIds.length}`);

    const vistos = new Set();
    for (const d of discussIds) {
      await page.goto(`${BASE_URL}/mod/forum/discuss.php?d=${d}`, { waitUntil: "load", timeout: TIMEOUT });
      await cerrarModal(page);
      const local = await extraerPostsForo(page);
      for (const p of local) {
        if (p.moodleUserId && !vistos.has(p.moodleUserId)) {
          vistos.add(p.moodleUserId);
          posts.push(p);
        }
      }
    }
    log(`[foro] Posts agregados desde discussions: ${posts.length}`);
  }

  // Matriculados del curso. Sprint 2.6 FIX E: si el caller pasa la lista (cache
  // por scan), saltamos la navegacion al grade report (~5s ahorrados x cada foro).
  let matriculados;
  if (Array.isArray(matriculadosCache) && matriculadosCache.length > 0) {
    matriculados = matriculadosCache;
    log(`[foro] Matriculados desde cache: ${matriculados.length}`);
  } else {
    matriculados = await obtenerMatriculados(page, courseId);
    log(`[foro] Matriculados detectados: ${matriculados.length}`);
  }

  // Construir resultado unificado
  const result = [];
  const idsPostearon = new Set();

  for (const p of posts) {
    if (!p.moodleUserId) continue;
    idsPostearon.add(p.moodleUserId);

    // Calificación: "-999" / "" / null → pendiente; cualquier otro valor → calificado.
    const v = p.ratingVal;
    const calificado = v != null && v !== "" && v !== "-999" && v !== "-1";
    result.push({
      nombre: p.nombre || `Aprendiz ${p.moodleUserId}`,
      aprendizMoodleId: p.moodleUserId,
      estado: calificado ? "calificado" : "pendiente",
    });
  }

  for (const m of matriculados) {
    if (!idsPostearon.has(m.moodleUserId)) {
      result.push({
        nombre: m.nombre,
        aprendizMoodleId: m.moodleUserId,
        estado: "sin_entregar",
      });
    }
  }

  log(`[foro] Total: ${result.length} (publicaron=${idsPostearon.size}, sin_entregar=${result.length - idsPostearon.size})`);
  return result;
}

module.exports = { obtenerEvidencias, revisarEntregas, revisarEntregasForo, extraerPostsForo, obtenerMatriculados };
