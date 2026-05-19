/**
 * scraper/probeCursosOtros.js
 *
 * Probe de solo lectura: encuentra todos los cursos del instructor en Zajuna,
 * navega a cursos distintos al courseId=50283 (ADSO inglés ya conocido),
 * busca Guías de aprendizaje y extrae RAPs de los PDFs encontrados.
 *
 * Objetivo: demostrar que la extracción de RAPs funciona para CUALQUIER
 * competencia del SENA, no solo inglés.
 *
 * Uso:
 *   node scraper/probeCursosOtros.js
 *
 * Salidas (consola): lista de cursos, PDFs encontrados, RAPs extraídos.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const https  = require("https");
const { chromium }                          = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt }                           = require("../api/src/lib/crypto");
const prisma                                = require("../api/src/db/client");

// ── Constantes ─────────────────────────────────────────────────────────────────

/** El curso ADSO/inglés que ya tenemos: lo omitimos para buscar otros */
const CURSO_CONOCIDO = 50283;

/** Máximo de cursos distintos a probar para no tardar demasiado */
const MAX_CURSOS = 3;

/** Regex para el bloque de resultados de aprendizaje en el PDF */
const BLOQUE_RAP_REGEX =
  /Resultados?\s+de\s+aprendizaje\s+a\s+alcanzar\s*[:\n]([\s\S]{0,4000})/i;

/** Código SENA estándar: 9 dígitos + guión + 2 dígitos */
const CODIGO_SENA_REGEX = /(\d{9})-(\d{2})/g;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extrae todos los cursos visibles en /my/courses.php
 * Retorna array de { courseId, nombre, href }
 */
async function extraerTodosLosCursos(page) {
  log("\n[cursos] Navegando a /my/courses.php ...");
  await page.goto(`${BASE_URL}/my/courses.php`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await cerrarModal(page);

  const cursos = await page.evaluate((baseUrl) => {
    const result = [];
    const vistos = new Set();

    // Estrategia 1: links directos a course/view.php
    document.querySelectorAll("a[href]").forEach((a) => {
      const m = a.href.match(/course\/view\.php\?id=(\d+)/);
      if (!m) return;
      const courseId = parseInt(m[1], 10);
      if (vistos.has(courseId)) return;
      vistos.add(courseId);
      const nombre = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (nombre.length > 1) {
        result.push({ courseId, nombre: nombre.substring(0, 120), href: a.href });
      }
    });

    return result.sort((a, b) => a.courseId - b.courseId);
  }, BASE_URL);

  log(`[cursos] ${cursos.length} curso(s) encontrado(s).`);
  return cursos;
}

/**
 * Navega al curso y busca la primera Guía de aprendizaje o Guía de formación.
 * Intenta también mediante API REST core_course_get_contents.
 * Retorna { href, nombre } del link de la guía, o null si no hay.
 */
async function buscarPrimeraGuia(page, courseId) {
  log(`\n[guia] Navegando a courseId=${courseId} ...`);
  await page.goto(`${BASE_URL}/course/view.php?id=${courseId}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await cerrarModal(page);

  // ── Intentar API REST para obtener módulos del curso ──────────────────────
  const apiResult = await page.evaluate(async ({ baseUrl, courseId }) => {
    const sesskey =
      window.M?.cfg?.sesskey ||
      document.querySelector('input[name="sesskey"]')?.value ||
      new URL(
        document.querySelector('a[data-title="logout,moodle"]')?.href || "http://x"
      ).searchParams.get("sesskey") ||
      null;
    if (!sesskey) return { ok: false, error: "No sesskey" };
    try {
      const res = await fetch(
        `${baseUrl}/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_contents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{
            index: 0,
            methodname: "core_course_get_contents",
            args: { courseid: Number(courseId) },
          }]),
        }
      );
      const json = await res.json();
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, { baseUrl: BASE_URL, courseId });

  if (apiResult.ok) {
    const secciones = apiResult.data?.[0]?.data;
    if (Array.isArray(secciones)) {
      for (const sec of secciones) {
        for (const mod of (sec.modules || [])) {
          const nombre = mod.name || "";
          if (/gu[íi]a\s+(de\s+)?(aprendizaje|formaci[oó]n)/i.test(nombre) && mod.url) {
            log(`[guia] Via API — "${nombre}"  →  ${mod.url.substring(0, 80)}`);
            return { href: mod.url, nombre };
          }
        }
      }
      log("[guia] API respondió pero sin guías en el árbol.");
    }
  }

  // ── Fallback DOM: buscar links con texto de guía ───────────────────────────
  const guiaLink = await page.evaluate(() => {
    for (const a of document.querySelectorAll("a[href]")) {
      const t = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (/gu[íi]a\s+(de\s+)?(aprendizaje|formaci[oó]n)/i.test(t)) {
        return { href: a.href, nombre: t.substring(0, 100) };
      }
    }
    return null;
  });

  if (guiaLink) {
    log(`[guia] Via DOM — "${guiaLink.nombre}"  →  ${guiaLink.href.substring(0, 80)}`);
  } else {
    log("[guia] No se encontró Guía de aprendizaje ni de formación en el DOM.");
  }
  return guiaLink;
}

/**
 * Navega a la página de la guía y extrae la URL del window.open del botón
 * "Clic aquí para acceder al recurso educativo".
 * Retorna la URL del PDF o null.
 */
async function extraerUrlPdfDeGuia(page, guiaHref) {
  log(`\n[pdf-url] Navegando a guía: ${guiaHref.substring(0, 100)}`);
  await page.goto(guiaHref, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await cerrarModal(page);

  // Buscar elemento con onclick que tenga window.open
  const onclick = await page.evaluate(() => {
    const el = document.querySelector("[onclick*='window.open']");
    return el ? el.getAttribute("onclick") : null;
  });

  if (onclick) {
    const m = onclick.match(/window\.open\s*\(\s*['"]([^'"]+)['"]/i);
    if (m) {
      const pdfPath = m[1];
      const pdfUrl = pdfPath.startsWith("/")
        ? "https://zajuna.sena.edu.co" + pdfPath
        : pdfPath;
      log(`[pdf-url] window.open URL: ${pdfUrl.substring(0, 100)}`);
      return pdfUrl;
    }
  }

  // Fallback: buscar links directos a pluginfile o .pdf
  const pdfLinks = await page.evaluate(() => {
    const found = [];
    document.querySelectorAll("a[href], iframe[src], embed[src]").forEach((el) => {
      const u = el.href || el.src || "";
      if (/pluginfile|\.pdf/i.test(u) && u.startsWith("http")) found.push(u);
    });
    return found;
  });

  if (pdfLinks.length > 0) {
    log(`[pdf-url] PDF link directo: ${pdfLinks[0].substring(0, 100)}`);
    return pdfLinks[0];
  }

  log("[pdf-url] No se encontró URL de PDF en la guía.");
  return null;
}

/**
 * Descarga un PDF usando las cookies de sesión de Playwright (método HTTPS Node.js).
 * Retorna Buffer o null.
 */
async function descargarPdf(ctx, pdfUrl) {
  log(`[descarga] Descargando: ${pdfUrl.substring(0, 100)}`);
  const cookies = await ctx.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  return new Promise((resolve) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const options = {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0",
      },
      agent,
    };
    const req = https.get(pdfUrl, options, (res) => {
      if (res.statusCode !== 200) {
        log(`[descarga] HTTP ${res.statusCode} — saltando.`);
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        log(`[descarga] OK — ${buf.length.toLocaleString()} bytes`);
        resolve(buf);
      });
      res.on("error", (e) => {
        log(`[descarga] Error en stream: ${e.message}`);
        resolve(null);
      });
    });
    req.on("error", (e) => {
      log(`[descarga] Error HTTPS: ${e.message}`);
      resolve(null);
    });
    req.setTimeout(30000, () => {
      log("[descarga] Timeout.");
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Parsea el buffer de un PDF con pdf-parse v2 y extrae el texto.
 * Retorna string o null.
 */
async function parsearPdf(buffer) {
  const { PDFParse } = require("pdf-parse");
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    log(`[pdf-parse] ${result.numpages} páginas, ${result.text.length.toLocaleString()} chars`);
    return result.text;
  } catch (e) {
    log(`[pdf-parse] Error: ${e.message}`);
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Obtener credenciales del primer instructor con fichas activas
  const ficha = await prisma.ficha.findFirst({
    where: { courseId: { not: 0 }, archivedAt: null },
    include: {
      user: { select: { zajunaUserEnc: true, zajunaPassEnc: true, nombre: true } },
    },
  });

  if (!ficha) {
    console.log("No hay fichas con courseId en la DB. Escanea fichas primero.");
    await prisma.$disconnect();
    return;
  }

  log(`\nInstructor: ${ficha.user.nombre}  (ficha ejemplo: ${ficha.codigo})`);

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  // headless:true — no necesitamos ver el navegador para este probe
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Ignorar nuevas pestañas que el window.open pueda lanzar
  ctx.on("page", async (np) => { await np.close().catch(() => {}); });

  const informe = {
    instructor: ficha.user.nombre,
    todosCursos: [],
    guiasEncontradas: [],
    rapsExtraidos: [],
  };

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    await login(page, zajunaUser, zajunaPass);

    // ── Extraer todos los cursos ──────────────────────────────────────────────
    informe.todosCursos = await extraerTodosLosCursos(page);

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  TODOS LOS CURSOS DEL INSTRUCTOR                             ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    for (const c of informe.todosCursos) {
      const marca = c.courseId === CURSO_CONOCIDO ? " ← ya conocido (inglés)" : "";
      console.log(`║  courseId=${String(c.courseId).padEnd(7)} | ${c.nombre.substring(0, 48).padEnd(48)} ${marca}`);
    }
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // ── Seleccionar cursos a explorar (distintos al conocido, máx 3) ──────────
    const cursosAExplorar = informe.todosCursos
      .filter((c) => c.courseId !== CURSO_CONOCIDO)
      .slice(0, MAX_CURSOS);

    if (cursosAExplorar.length === 0) {
      console.log("Solo se encontró el curso conocido (50283). No hay otros cursos para probar.");
      return;
    }

    log(`\n[explorar] Cursos a probar: ${cursosAExplorar.map((c) => c.courseId).join(", ")}`);

    // ── Por cada curso: buscar guía → extraer PDF → parsear RAPs ──────────────
    for (const curso of cursosAExplorar) {
      console.log(`\n${"═".repeat(65)}`);
      console.log(`  EXPLORANDO courseId=${curso.courseId}: "${curso.nombre.substring(0, 50)}"`);
      console.log(`${"═".repeat(65)}`);

      // 1. Buscar primera guía
      const guiaLink = await buscarPrimeraGuia(page, curso.courseId);
      if (!guiaLink) {
        console.log(`  → Sin guías de aprendizaje/formación. Saltando.`);
        continue;
      }

      informe.guiasEncontradas.push({
        courseId: curso.courseId,
        cursoNombre: curso.nombre,
        guiaNombre: guiaLink.nombre,
        guiaHref: guiaLink.href,
      });

      // 2. Extraer URL del PDF
      const pdfUrl = await extraerUrlPdfDeGuia(page, guiaLink.href);
      if (!pdfUrl) {
        console.log(`  → Guía encontrada pero sin PDF accesible.`);
        continue;
      }

      console.log(`\n  PDF URL: ${pdfUrl}`);

      // 3. Descargar PDF
      const pdfBuffer = await descargarPdf(ctx, pdfUrl);
      if (!pdfBuffer) {
        console.log(`  → PDF no se pudo descargar.`);
        continue;
      }

      // 4. Parsear texto
      const textoPdf = await parsearPdf(pdfBuffer);
      if (!textoPdf) {
        console.log(`  → PDF descargado pero no se pudo parsear el texto.`);
        continue;
      }

      // 5. Mostrar primeros 2000 chars del texto
      console.log(`\n  TEXTO DEL PDF (primeros 2000 chars):`);
      console.log("  " + textoPdf.substring(0, 2000).replace(/\n/g, "\n  "));

      // 6. Buscar bloque RAP y códigos SENA
      const bloqueMatch = textoPdf.match(BLOQUE_RAP_REGEX);
      const textoParaBuscar = bloqueMatch ? bloqueMatch[1] : textoPdf;

      // Extraer todos los códigos SENA del bloque (o de todo el texto si no hay bloque)
      const codigosEncontrados = [];
      const vistosCodigos = new Set();
      for (const m of textoParaBuscar.matchAll(CODIGO_SENA_REGEX)) {
        const codigo = `${m[1]}-${m[2]}`;
        if (!vistosCodigos.has(codigo)) {
          vistosCodigos.add(codigo);
          codigosEncontrados.push({
            codigoSena: codigo,
            competencia: m[1],
            rapNum: parseInt(m[2], 10),
          });
        }
      }

      console.log(`\n  BLOQUE 'Resultados de aprendizaje': ${bloqueMatch ? "ENCONTRADO" : "NO encontrado — buscando en todo el PDF"}`);
      console.log(`  Códigos SENA encontrados: ${codigosEncontrados.length}`);
      codigosEncontrados.forEach((c) =>
        console.log(`    ${c.codigoSena}  (competencia=${c.competencia}, RAP ${c.rapNum})`)
      );

      informe.rapsExtraidos.push({
        courseId: curso.courseId,
        cursoNombre: curso.nombre,
        pdfUrl,
        bloqueEncontrado: !!bloqueMatch,
        codigosEncontrados,
      });
    }

    // ── Resumen final ─────────────────────────────────────────────────────────
    console.log("\n\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  RESUMEN FINAL                                               ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");

    if (informe.rapsExtraidos.length === 0) {
      console.log("║  No se encontraron RAPs en otros cursos.                     ║");
      console.log(`║  Guías encontradas: ${informe.guiasEncontradas.length}                                        ║`);
    } else {
      // Frecuencia de competencias
      const freqCompetencias = {};
      for (const r of informe.rapsExtraidos) {
        for (const c of r.codigosEncontrados) {
          freqCompetencias[c.competencia] = (freqCompetencias[c.competencia] || 0) + 1;
        }
      }
      const competenciasOrdenadas = Object.entries(freqCompetencias)
        .sort((a, b) => b[1] - a[1]);

      console.log("║  PDFs con RAPs extraídos:                                    ║");
      for (const r of informe.rapsExtraidos) {
        const competencias = [...new Set(r.codigosEncontrados.map((c) => c.competencia))];
        console.log(`║    courseId=${r.courseId}: ${r.codigosEncontrados.length} código(s), competencia(s): ${competencias.join(", ")}`);
      }
      console.log("╠══════════════════════════════════════════════════════════════╣");
      console.log("║  Competencias por frecuencia:                                ║");
      for (const [cod, freq] of competenciasOrdenadas) {
        const esMasFrec = competenciasOrdenadas[0][0] === cod ? " ← MAS FRECUENTE" : "";
        console.log(`║    ${cod}: ${freq} aparición(es)${esMasFrec}`);
      }
    }

    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Total cursos del instructor: ${informe.todosCursos.length}`);
    console.log(`║  Cursos explorados (excl. inglés): ${cursosAExplorar.length} / ${MAX_CURSOS} max`);
    console.log("╚══════════════════════════════════════════════════════════════╝");

  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
