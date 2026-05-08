#!/usr/bin/env node
/**
 * zajuna-evidencias.js  v5
 * Uso: node zajuna-evidencias.js <ficha> [--no-headless]
 *
 * Requiere:
 *   npm install playwright dotenv
 *   npx playwright install chromium
 *
 * .env:
 *   ZAJUNA_USER=1052499107
 *   ZAJUNA_PASS=tupassword
 */

const { chromium } = require("playwright");
require("dotenv").config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const FICHAS = {
  "3070432": { programa: "ADSO",           guia: 6, id: 28221 },
  "3186683": { programa: "ADSO",           guia: 5, id: 50283 },
  "3186684": { programa: "ADSO",           guia: 5, id: 51083 },
  "3336023": { programa: "PROG. SOFTWARE", guia: 3, id: 77767 },
};

const CODIGO_INGLES = "240202501";
const BASE_URL      = "https://zajuna.sena.edu.co/zajuna";
const TIMEOUT       = 30_000;

// ─── UTILS ───────────────────────────────────────────────────────────────────

function log(msg) { console.error(`[${new Date().toISOString()}] ${msg}`); }

async function cerrarModal(page) {
  try {
    const modal = page.locator('#connection-guard-modal');
    const visible = await modal.isVisible({ timeout: 4000 }).catch(() => false);
    if (!visible) return;
    log("Modal detectado, cerrando...");
    // Intentar click en el último botón del modal (el ×)
    await modal.locator('button').last().click({ force: true });
    await page.waitForTimeout(800);
    // Fallback JS por si el click no bastó
    const sigueVisible = await modal.isVisible({ timeout: 1000 }).catch(() => false);
    if (sigueVisible) {
      await page.evaluate(() => {
        const m = document.getElementById('connection-guard-modal');
        if (m) m.style.display = 'none';
      });
    }
    log("Modal cerrado.");
  } catch (e) {
    log(`cerrarModal: ${e.message}`);
  }
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────

async function login(page, user, pass) {
  log("Abriendo Zajuna...");
  await page.goto("https://zajuna.sena.edu.co", { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  // Selectores confirmados por inspección real
  await page.locator('select[name="typeDocument"]').selectOption("CC");
  log("Tipo documento: CC.");

  await page.locator('input[name="document"]').fill(user);
  log("Documento ingresado.");

  await page.locator('input[name="password"]').first().fill(pass);
  log("Contraseña ingresada.");

  await cerrarModal(page); // por si el modal volvió

  await page.locator('button[name="form_login_user"]').click({ force: true });
  log("Botón login clickeado.");

  // Esperar hasta estar en una página que no sea el login
  await page.waitForFunction(
    () => !window.location.href.includes("zajuna.sena.edu.co") ||
           window.location.pathname !== "/" ,
    { timeout: TIMEOUT }
  ).catch(() => {});

  await cerrarModal(page);
  log(`URL post-login: ${page.url()}`);

  const hayError = await page.locator(".loginerrors, .alert-danger").isVisible().catch(() => false);
  if (hayError) throw new Error("Credenciales incorrectas.");
  log("Sesión iniciada ✓");
}

// ─── NAVEGAR AL CURSO ────────────────────────────────────────────────────────

async function navegarACurso(page, courseId) {
  const url = `${BASE_URL}/course/view.php?id=${courseId}`;
  log(`Abriendo curso: ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);
  log(`Título: ${await page.title()}`);
}

// ─── RECOPILAR EVIDENCIAS ────────────────────────────────────────────────────

async function obtenerEvidencias(page) {
  log(`Buscando actividades con código ${CODIGO_INGLES}...`);

  // Expandir secciones colapsadas que tengan el código
  const cabeceras = page.locator("a, span").filter({ hasText: "Actividad de aprendizaje" });
  const nCab = await cabeceras.count();
  log(`Cabeceras "Actividad de aprendizaje": ${nCab}`);

  for (let i = 0; i < nCab; i++) {
    const cab = cabeceras.nth(i);
    const texto = (await cab.textContent().catch(() => "")).trim();
    if (!texto.includes(CODIGO_INGLES)) continue;

    const expandida = await cab.evaluate(el => {
      const li = el.closest("li");
      return li ? !li.classList.contains("collapsed") : true;
    }).catch(() => true);

    if (!expandida) {
      log(`  Expandiendo: ${texto}`);
      await cab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  // Recopilar links de evidencias calificables
  const links = await page.$$eval("a", (as, codigo) =>
    as
      .filter(a => {
        const href = a.href || "";
        const txt  = (a.textContent || "").trim();
        return (
          href.includes("/mod/") &&
          txt.includes(codigo) &&
          !/cuestionario|quiz/i.test(txt) &&
          !/borrador|draft/i.test(txt)
        );
      })
      .map(a => ({
        texto: (a.textContent || "").replace(/\s+/g, " ").trim(),
        href: a.href,
      })),
    CODIGO_INGLES
  );

  // Deduplicar por href
  const vistos = new Set();
  const unicos = links.filter(l => {
    if (vistos.has(l.href)) return false;
    vistos.add(l.href);
    return true;
  });

  log(`Evidencias calificables: ${unicos.length}`);
  unicos.forEach(u => log(`  • ${u.texto}`));
  return unicos;
}

// ─── REVISAR ENTREGAS ─────────────────────────────────────────────────────────

async function revisarEntregas(page, evidencia) {
  log(`\nRevisando: ${evidencia.texto}`);

  const esAssign = evidencia.href.includes("/mod/assign/");

  if (!esAssign) {
    await page.goto(evidencia.href, { waitUntil: "load", timeout: TIMEOUT });
    await cerrarModal(page);
    const filas = await page.$$eval(".generaltable tbody tr", rows =>
      rows.map(r => Array.from(r.querySelectorAll("td")).map(c => c.textContent.trim()))
    ).catch(() => []);
    const estudiantes = filas
      .filter(c => c.length >= 2 && c[0].length > 2)
      .map(cols => ({
        nombre: cols[0].substring(0, 60),
        estado: /calificado|graded/i.test(cols.join(" ")) ? "calificado" : "pendiente",
      }));
    return { nombre: evidencia.texto, tipo: "otro", estudiantes };
  }

  const m = evidencia.href.match(/[?&]id=(\d+)/);
  if (!m) { log("  Sin ID, omitiendo."); return null; }
  const actId = m[1];

  const urlGrading = `${BASE_URL}/mod/assign/view.php?id=${actId}&action=grading`;
  log(`  → ${urlGrading}`);
  await page.goto(urlGrading, { waitUntil: "load", timeout: TIMEOUT });
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

  // Esperar a que la tabla esté presente
  await page.waitForSelector(".generaltable tbody tr", { timeout: 10000 }).catch(() => {});

  // Filtrar solo filas principales (td.cell.c0) y solo celdas normales (td.cell),
  // ignorando las filas y celdas de los ygtvtable anidados en los adjuntos.
  const filas = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".generaltable tbody tr"));
    return rows
      .filter(row => row.querySelector("td.cell.c0"))
      .map(row => ({
        cols: Array.from(row.querySelectorAll("td.cell"))
          .map(td => (td.textContent || "").replace(/\s+/g, " ").trim()),
      }));
  });

  log(`  Filas en tabla: ${filas.length}`);

  const estudiantes = [];
  for (const { cols } of filas) {
    if (cols.length < 3) continue;
    // col[2] = nombre completo; col[5] = estado de entrega + calificación
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

    estudiantes.push({ nombre, estado });
  }

  // Fallback: resumen si tabla vacía
  if (estudiantes.length === 0) {
    await page.goto(evidencia.href, { waitUntil: "load", timeout: TIMEOUT });
    const resumen = await page.$$eval(
      ".submissionsummary td, .gradingsummary td",
      tds => tds.map(td => td.textContent.trim())
    ).catch(() => []);
    return { nombre: evidencia.texto, tipo: "assign", estudiantes: [], resumen: resumen.join(" | ") };
  }

  return { nombre: evidencia.texto, tipo: "assign", estudiantes };
}

// ─── REPORTE ─────────────────────────────────────────────────────────────────

function imprimirReporte(ficha, guia, programa, resultados) {
  const sep = "═".repeat(58);
  const lin = "─".repeat(58);
  const hora = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

  console.log();
  console.log(sep);
  console.log(`  FICHA ${ficha} | ${programa} | GUÍA ${guia}`);
  console.log(`  ${hora}`);
  console.log(sep);

  if (!resultados.length) {
    console.log(`  Sin evidencias ${CODIGO_INGLES} encontradas.`);
    console.log(sep);
    return;
  }

  let totalPendientes = 0;

  for (const act of resultados) {
    console.log();
    console.log(`▸ ${act.nombre}`);
    console.log(lin);

    if (act.resumen) {
      console.log(`  Resumen: ${act.resumen}`);
      continue;
    }

    if (!act.estudiantes || act.estudiantes.length === 0) {
      console.log("  Sin datos de estudiantes.");
      continue;
    }

    const pendientes  = act.estudiantes.filter(e => e.estado === "pendiente");
    const calificados = act.estudiantes.filter(e => e.estado === "calificado");
    const sinEntregar = act.estudiantes.filter(e => e.estado === "sin_entregar");
    const desc        = act.estudiantes.filter(e => e.estado === "desconocido");

    totalPendientes += pendientes.length;

    console.log(`  Total aprendices  : ${act.estudiantes.length}`);
    console.log(`  ⏳ Pendiente cal. : ${pendientes.length}`);
    console.log(`  ✅ Calificado     : ${calificados.length}`);
    console.log(`  🚫 Sin entregar   : ${sinEntregar.length}`);
    if (desc.length) console.log(`  ❓ Desconocido    : ${desc.length}`);

    if (pendientes.length > 0) {
      console.log();
      console.log("  PENDIENTES POR CALIFICAR:");
      pendientes.forEach((e, i) =>
        console.log(`    ${String(i + 1).padStart(2, "0")}. ${e.nombre}`)
      );
    }
  }

  console.log();
  console.log(sep);
  console.log(`  TOTAL PENDIENTES: ${totalPendientes}`);
  console.log(`${sep}\n`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const ficha    = args.find(a => /^\d{7}$/.test(a));
  const headless = !args.includes("--no-headless");

  if (!ficha || !FICHAS[ficha]) {
    console.error("Uso: node zajuna-evidencias.js <ficha> [--no-headless]");
    console.error("Fichas: " + Object.keys(FICHAS).join(", "));
    process.exit(1);
  }

  const { guia, id, programa } = FICHAS[ficha];
  const user = process.env.ZAJUNA_USER;
  const pass = process.env.ZAJUNA_PASS;

  if (!user || !pass) {
    console.error("ERROR: Crea .env con ZAJUNA_USER y ZAJUNA_PASS");
    process.exit(1);
  }

  log(`─── Ficha ${ficha} | ${programa} | Guía ${guia} | Course ID: ${id} ───`);

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 100 });
  const ctx  = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    await login(page, user, pass);
    await navegarACurso(page, id);
    const evidencias = await obtenerEvidencias(page);

    if (evidencias.length === 0) {
      console.log(`\n⚠️  Sin evidencias ${CODIGO_INGLES} — corre con --no-headless para depurar.\n`);
      await browser.close();
      return;
    }

    const resultados = [];
    for (const ev of evidencias) {
      const r = await revisarEntregas(page, ev);
      if (r) resultados.push(r);
    }

    imprimirReporte(ficha, guia, programa, resultados);

  } catch (err) {
    log(`ERROR: ${err.message}`);
    const shot = `error-ficha-${ficha}-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    log(`Screenshot: ${shot}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
