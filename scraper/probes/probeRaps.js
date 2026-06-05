/**
 * Script de prueba: intenta extraer RAPs del framework de competencias de Zajuna.
 * Corre con: node scraper/probeRaps.js
 *
 * Prueba dos métodos:
 *   1. core_competency_list_course_competencies (API Moodle)
 *   2. regex RAP\d+ sobre nombres de evidencias en DB (fallback)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

async function probeCompetencyApi(page, courseId) {
  log(`\n[probe] Llamando core_competency_list_course_competencies para courseId=${courseId}...`);

  const result = await page.evaluate(async ({ baseUrl, courseId }) => {
    const sesskey = window.M?.cfg?.sesskey
      || document.querySelector('input[name="sesskey"]')?.value
      || new URL(document.querySelector('a[data-title="logout,moodle"]')?.href || "http://x")
           .searchParams.get("sesskey");

    if (!sesskey) return { ok: false, error: "No sesskey" };

    const url = `${baseUrl}/lib/ajax/service.php?sesskey=${sesskey}&info=core_competency_list_course_competencies`;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify([{
          index:      0,
          methodname: "core_competency_list_course_competencies",
          args:       { id: Number(courseId) },
        }]),
      });
      const json = await res.json();
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, { baseUrl: BASE_URL, courseId });

  return result;
}

async function probeCourseSections(page, courseId) {
  log(`\n[probe] Buscando secciones/actividades con nombre RAP en courseId=${courseId}...`);
  await page.goto(`${BASE_URL}/course/view.php?id=${courseId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await cerrarModal(page);

  const items = await page.evaluate(() => {
    const results = [];
    // Secciones del curso
    document.querySelectorAll(".sectionname, h3.section-title").forEach(el => {
      const text = el.textContent?.trim();
      if (text) results.push({ tipo: "seccion", texto: text });
    });
    // Actividades/recursos
    document.querySelectorAll(".activityname, .instancename").forEach(el => {
      const text = el.textContent?.trim();
      if (text) results.push({ tipo: "actividad", texto: text });
    });
    return results;
  });

  const RAP_REGEX = /RAP\s*(\d+)/i;
  const raps = items
    .filter(i => RAP_REGEX.test(i.texto))
    .map(i => ({ ...i, rapNum: i.texto.match(RAP_REGEX)?.[1] }));

  return raps;
}

async function main() {
  // Tomar el primer usuario activo que tenga fichas con courseId
  const ficha = await prisma.ficha.findFirst({
    where:   { courseId: { not: 0 }, archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true, nombre: true } } },
  });

  if (!ficha) {
    console.log("No hay fichas con courseId en la DB. Escanea fichas primero.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\nUsando ficha: ${ficha.codigo} (courseId=${ficha.courseId}) del usuario ${ficha.user.nombre}`);

  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  const browser = await chromium.launch({ headless: false }); // visible para debug
  const ctx  = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await login(page, zajunaUser, zajunaPass);
    console.log("Login OK");

    // ── Método 1: API de competencias ──────────────────────────────────────────
    const competencyResult = await probeCompetencyApi(page, ficha.courseId);
    console.log("\n=== RESULTADO API COMPETENCIAS ===");
    console.log(JSON.stringify(competencyResult, null, 2));

    const tieneCompetencias = competencyResult.ok &&
      Array.isArray(competencyResult.data?.[0]?.data) &&
      competencyResult.data[0].data.length > 0;

    if (tieneCompetencias) {
      console.log("\n✅ ZAJUNA TIENE COMPETENCIAS CONFIGURADAS");
      console.log("RAPs encontrados vía API:");
      competencyResult.data[0].data.forEach(c => {
        console.log(`  ${c.competency?.shortname ?? "?"}: ${c.competency?.idnumber ?? ""} — ${c.competency?.description ?? ""}`);
      });
    } else {
      console.log("\n⚠️  API de competencias vacía o no habilitada. Probando secciones del curso...");

      // ── Método 2: secciones con nombre RAP ──────────────────────────────────
      const secciones = await probeCourseSections(page, ficha.courseId);
      console.log("\n=== SECCIONES/ACTIVIDADES CON RAP ===");
      if (secciones.length === 0) {
        console.log("No se encontraron secciones/actividades con nombre RAP en este curso.");
        console.log("Conclusión: los RAPs deberán importarse manualmente via JSON.");
      } else {
        console.log("Hallazgos:");
        secciones.forEach(s => console.log(`  RAP${s.rapNum}: [${s.tipo}] ${s.texto}`));
        console.log("\n✅ Se puede extraer el número de RAP de los nombres de actividades.");
      }
    }

  } finally {
    await page.waitForTimeout(3000); // tiempo para leer el resultado en el navegador
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
