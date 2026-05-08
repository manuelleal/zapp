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
          return (
            href.includes("/mod/assign/") &&
            txt.includes(codigo) &&
            !/cuestionario|quiz/i.test(txt) &&
            !/borrador|draft/i.test(txt)
          );
        })
        .map(a => {
          const m = a.href.match(/[?&]id=(\d+)/);
          return {
            texto: (a.textContent || "").replace(/\s+/g, " ").trim(),
            href:  a.href,
            actId: m ? m[1] : null,
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

module.exports = { obtenerEvidencias, revisarEntregas };
