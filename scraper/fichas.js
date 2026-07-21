/**
 * scraper/fichas.js
 * Descubre las fichas asignadas al instructor en Zajuna.
 *
 * Uso CLI (prueba):
 *   node scraper/fichas.js [--no-headless]
 *
 * Como módulo:
 *   const { descubrirFichas } = require("./scraper/fichas");
 */

const { chromium } = require("playwright");
require("dotenv").config();

const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");

// ─── COMPETENCIAS CONOCIDAS ───────────────────────────────────────────────────

const COMPETENCIAS = [
  { nombre: "Inglés",                    codigo: "240202501" },
  { nombre: "Bases de datos",            codigo: "220501046" },
  { nombre: "Programación de software",  codigo: "220501046" },
  { nombre: "Análisis y desarrollo",     codigo: "220501040" },
];

// ─── EXTRACCIÓN DE CURSOS ─────────────────────────────────────────────────────

async function extraerCursosDelDOM(page) {
  return page.evaluate(() => {
    let links = Array.from(document.querySelectorAll('a[href*="course/view.php"]'));
    if (links.length === 0)
      links = Array.from(document.querySelectorAll('.coursebox a[href*="view.php"]'));
    if (links.length === 0)
      links = Array.from(document.querySelectorAll('[data-courseid] a'));

    const vistos = new Set();
    const cursos = [];

    for (const a of links) {
      const url   = a.href || "";
      const m     = url.match(/[?&]id=(\d+)/);
      if (!m) continue;

      const courseId = parseInt(m[1], 10);
      if (vistos.has(courseId)) continue;
      vistos.add(courseId);

      let nombre = (a.textContent || a.title || "").replace(/\s+/g, " ").trim();
      if (!nombre && a.parentElement?.dataset?.coursename)
        nombre = a.parentElement.dataset.coursename;
      if (!nombre) continue;

      cursos.push({ courseId, nombre, href: url });
    }

    return cursos;
  });
}

// ─── PAGINACIÓN ──────────────────────────────────────────────────────────────

async function iterarPaginasCursos(page, extraerFunc) {
  const todos = [];
  const MAX_PAGINAS = 10;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    log(`  Extrayendo página ${pagina}...`);
    const cursos = await extraerFunc(page);

    for (const c of cursos) {
      if (!todos.find(x => x.courseId === c.courseId)) todos.push(c);
    }

    const hayProxima = await page.evaluate(() => {
      const btn = document.querySelector(
        'a[aria-label*="siguiente"], a[title*="Próxima"], .pagination .next'
      );
      return !!(btn && !btn.classList.contains("disabled"));
    });

    if (!hayProxima) break;

    await page.click('a[aria-label*="siguiente"], a[title*="Próxima"], .pagination .next')
      .catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);
  }

  return todos;
}

// ─── DESCUBRIMIENTO VÍA WEBSERVICE (primario) ────────────────────────────────
// El bloque "Vista general de cursos" de Moodle pinta la lista llamando al WS
// core_course_get_enrolled_courses_by_timeline_classification. Lo llamamos igual
// (classification=all, limit=0) para traer TODOS los cursos matriculados de una,
// sin depender de la paginación/filtro del DOM de /my/courses.php (que en el
// servidor sólo cargaba la primera tanda → dejaba fichas afuera, ej. 3186684).

async function obtenerSesskey(page) {
  let k = await page.evaluate(() => (window.M && window.M.cfg && window.M.cfg.sesskey) || "").catch(() => "");
  if (!k) {
    const html = await page.content().catch(() => "");
    k = (html.match(/"sesskey":"([^"]+)"/) || html.match(/[?&]sesskey=([A-Za-z0-9]+)/) || [])[1] || "";
  }
  return k;
}

async function obtenerCursosViaAjax(page) {
  try {
    const sesskey = await obtenerSesskey(page);
    if (!sesskey) { log("WS cursos: sin sesskey."); return []; }
    const data = await page.evaluate(async ({ sesskey, base }) => {
      const body = [{
        index: 0,
        methodname: "core_course_get_enrolled_courses_by_timeline_classification",
        args: { offset: 0, limit: 0, classification: "all", sort: "fullname",
                customfieldname: "", customfieldvalue: "" },
      }];
      const res = await fetch(
        `${base}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_course_get_enrolled_courses_by_timeline_classification`,
        { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) }
      );
      const json = await res.json();
      if (!Array.isArray(json) || json[0]?.error) {
        return { error: json?.[0]?.exception?.message || "WS error", courses: [] };
      }
      return { courses: json[0]?.data?.courses || [] };
    }, { sesskey, base: BASE_URL });

    if (data.error) { log(`WS cursos no disponible: ${data.error}`); return []; }
    return (data.courses || []).map(c => ({
      courseId: c.id,
      nombre:   c.fullname || c.shortname || "",
      href:     c.viewurl || `${BASE_URL}/course/view.php?id=${c.id}`,
    }));
  } catch (e) {
    log(`WS cursos falló: ${e.message}`);
    return [];
  }
}

// ─── DESCUBRIR FICHAS ─────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  — página ya autenticada
 * @param {string} competenciaCodigo        — ej: "240202501"
 * @returns {Promise<Array>}                — array de fichas encontradas
 */
async function descubrirFichas(page, competenciaCodigo) {
  const fichasMap = new Map(); // courseId → ficha

  // ── Intento 0 (PRIMARIO): WS de cursos matriculados (todos de una) ─────────
  let cursos = await obtenerCursosViaAjax(page);
  if (cursos.length) {
    log(`Intento 0 (WS timeline): ${cursos.length} cursos matriculados.`);
  } else {
    // ── Intento 1 (FALLBACK): DOM de /my/courses.php ─────────────────────────
    const urlActual = page.url();
    if (!urlActual.includes("/my/")) {
      log("Navegando a /my/courses.php ...");
      await page.goto(`${BASE_URL}/my/courses.php`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    } else {
      log(`Ya en página de cursos: ${urlActual}`);
    }
    await cerrarModal(page);
    await page.waitForTimeout(500);
    cursos = await iterarPaginasCursos(page, extraerCursosDelDOM);
    log(`Intento 1 (DOM): ${cursos.length} cursos encontrados.`);
  }
  cursos.slice(0, 3).forEach(c => log(`  - ${c.courseId}: ${c.nombre}`));
  if (cursos.length > 3) log(`  ... y ${cursos.length - 3} más`);

  // ── Intento 2: /my/ si el intento 1 dio pocos ─────────────────────────────
  if (cursos.length < 2) {
    log("Pocos cursos, probando /my/ ...");
    await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await cerrarModal(page);
    await page.waitForTimeout(500);
    const extra = await iterarPaginasCursos(page, extraerCursosDelDOM);
    log(`/my/courses.php: ${extra.length} cursos.`);
    for (const c of extra) {
      if (!cursos.find(x => x.courseId === c.courseId)) cursos.push(c);
    }
  }

  // ── Intento 3: bloques y menús laterales de Moodle ───────────────────────
  if (cursos.length < 2) {
    log("Buscando cursos en bloques y navegación lateral...");
    const extra = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll(
        ".block_myoverview a[href*='course'], " +
        "[class*='course-item'] a[href*='view.php'], " +
        "nav a[href*='course/view']"
      ));
      return links.map(a => ({
        url: a.href || "",
        nombre: (a.textContent || a.title || "").replace(/\s+/g, " ").trim(),
      }));
    });
    for (const { url, nombre } of extra) {
      const m = url.match(/[?&]id=(\d+)/);
      if (m && nombre) {
        const courseId = parseInt(m[1], 10);
        if (!cursos.find(c => c.courseId === courseId))
          cursos.push({ courseId, nombre, href: url });
      }
    }
    log(`Bloques: ${extra.length} links encontrados → total ${cursos.length} cursos.`);
  }

  log(`Total cursos únicos antes de parsear: ${cursos.length}`);

  // ── Una sola visita a /course/index.php para mapear programas ───────────────
  const mapaPrograma = await construirMapaPrograma(page);

  // ── Parsear cada curso: extraer ficha y asignar programa ─────────────────────
  for (const curso of cursos) {
    const { courseId, nombre, href } = curso;

    const mCodigo = nombre.match(/V_([23]\d{6})/) || nombre.match(/\b([23]\d{6})\b/);
    const codigo  = mCodigo ? mCodigo[1] : null;
    const programa = mapaPrograma[courseId] || codigoP(nombre) && `P_${codigoP(nombre)}` || "";

    fichasMap.set(courseId, {
      codigo,
      nombre,
      courseId,
      programa,
      href,
      tieneCodigoFicha: !!codigo,
    });
  }

  const fichas = Array.from(fichasMap.values());

  // Separar las que tienen código de ficha de las que no
  const conCodigo = fichas.filter(f => f.tieneCodigoFicha);
  const sinCodigo = fichas.filter(f => !f.tieneCodigoFicha);

  log(`Fichas con código de 7 dígitos: ${conCodigo.length}`);
  log(`Cursos sin código reconocido:   ${sinCodigo.length}`);

  return { fichas: conCodigo, otrosCursos: sinCodigo };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function codigoP(nombre) {
  const m = nombre.match(/P_(\d+)_/);
  return m ? m[1] : null;
}

/**
 * Una sola visita a /course/index.php para construir el mapa completo
 * courseId → nombre de categoría (programa). Moodle lista los cursos
 * agrupados por categoría en esa página.
 */
async function construirMapaPrograma(page) {
  log("Construyendo mapa de programas desde /course/index.php ...");
  const mapa = {}; // courseId → nombrePrograma

  try {
    await page.goto(`${BASE_URL}/course/index.php`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await cerrarModal(page);

    const resultado = await page.evaluate(() => {
      const mapa = {};

      // Estructura típica Moodle: .category con h3/h4 de nombre y links de cursos dentro
      const categorias = Array.from(document.querySelectorAll(".category, .coursecategory"));
      for (const cat of categorias) {
        const nombre = (
          cat.querySelector("h3, h4, .categoryname, .name")?.textContent || ""
        ).trim();
        if (!nombre) continue;
        for (const a of cat.querySelectorAll('a[href*="course/view.php"]')) {
          const m = a.href.match(/[?&]id=(\d+)/);
          if (m) mapa[parseInt(m[1], 10)] = nombre;
        }
      }

      // Fallback: si no hay .category, buscar links agrupados bajo encabezados
      if (Object.keys(mapa).length === 0) {
        let categoriaActual = "";
        for (const el of document.querySelectorAll("h3, h4, a[href*='course/view.php']")) {
          if (el.matches("h3, h4")) {
            categoriaActual = el.textContent.trim();
          } else if (categoriaActual) {
            const m = el.href.match(/[?&]id=(\d+)/);
            if (m) mapa[parseInt(m[1], 10)] = categoriaActual;
          }
        }
      }

      return mapa;
    });

    const total = Object.keys(resultado).length;
    log(`Mapa de programas: ${total} cursos mapeados.`);
    Object.assign(mapa, resultado);

  } catch (e) {
    log(`construirMapaPrograma: ${e.message}`);
  }

  return mapa;
}

// ─── REPORTE CLI ──────────────────────────────────────────────────────────────

function imprimirFichas({ fichas, otrosCursos }) {
  const sep = "═".repeat(62);
  const lin = "─".repeat(62);
  const hora = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

  console.log();
  console.log(sep);
  console.log(`  FICHAS DEL INSTRUCTOR — ${hora}`);
  console.log(sep);

  if (fichas.length === 0) {
    console.log("  ⚠️  No se encontraron fichas con código de 7 dígitos.");
    console.log("  Revisa con --no-headless para inspeccionar la página.");
  } else {
    console.log(`\n  FICHAS IDENTIFICADAS (${fichas.length}):\n`);
    fichas.forEach((f, i) => {
      console.log(`  ${String(i + 1).padStart(2, "0")}. [${f.codigo}] ${f.nombre}`);
      console.log(`      Programa  : ${f.programa || "—"}`);
      console.log(`      Course ID : ${f.courseId}`);
    });
  }

  if (otrosCursos.length > 0) {
    console.log(`\n${lin}`);
    console.log(`  OTROS CURSOS SIN CÓDIGO DE FICHA (${otrosCursos.length}):\n`);
    otrosCursos.forEach((c, i) => {
      console.log(`  ${String(i + 1).padStart(2, "0")}. [ID:${c.courseId}] ${c.nombre}`);
    });
  }

  // Bloque JSON listo para pegar en zajuna-evidencias.js
  if (fichas.length > 0) {
    console.log(`\n${sep}`);
    console.log("  JSON para pegar en FICHAS de zajuna-evidencias.js:\n");
    const obj = {};
    fichas.forEach(f => {
      obj[f.codigo] = {
        programa: f.programa || "—",
        guia: 1,         // ajustar manualmente
        id: f.courseId,
      };
    });
    console.log(JSON.stringify(obj, null, 2));
  }

  console.log(`\n${sep}\n`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const headless = !args.includes("--no-headless");

  const user = process.env.ZAJUNA_USER;
  const pass = process.env.ZAJUNA_PASS;

  if (!user || !pass) {
    console.error("ERROR: Crea .env con ZAJUNA_USER y ZAJUNA_PASS");
    process.exit(1);
  }

  // Selección de competencia interactiva
  const competencia = await seleccionarCompetencia();
  log(`Competencia seleccionada: ${competencia.nombre} (${competencia.codigo})`);

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });
  // userAgent camuflado: el WAF del SENA bloquea "HeadlessChrome" (jul-2026).
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    await login(page, user, pass);
    const resultado = await descubrirFichas(page, competencia.codigo);
    imprimirFichas(resultado);

  } catch (err) {
    log(`ERROR: ${err.message}`);
    const shot = `error-fichas-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    log(`Screenshot guardado: ${shot}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

async function seleccionarCompetencia() {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    console.log("\n¿Cuál es tu competencia?");
    COMPETENCIAS.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.nombre.padEnd(30)} (${c.codigo})`);
    });
    console.log(`  ${COMPETENCIAS.length + 1}. Otra (ingresar código manualmente)`);

    rl.question("\n> ", async answer => {
      const n = parseInt(answer.trim(), 10);
      rl.close();

      if (n >= 1 && n <= COMPETENCIAS.length) {
        resolve(COMPETENCIAS[n - 1]);
      } else {
        // pedir código manual
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question("Código de competencia: ", codigo => {
          rl2.close();
          resolve({ nombre: "Personalizada", codigo: codigo.trim() });
        });
      }
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = { descubrirFichas, COMPETENCIAS };
