/**
 * scripts/probe-assign-raw-json.js
 *
 * PROBE de decisión para el estado "reenviado" (y confirmación de "borrador").
 *
 * Pregunta que responde: ¿el AJAX `mod_assign_list_participants` de SENA expone
 * ALGÚN campo que nos permita distinguir un REENVÍO (el aprendiz volvió a
 * entregar tras una primera entrega) — p.ej. número de intento, fecha de
 * modificación, "reopened" con intento > 1 — y aparece "draft" de verdad?
 *
 * Hoy el worker solo lee `submitted`, `requiregrading` y `submissionstatus`
 * (ver scraper/evidencias.js:598-607). Antes de diseñar "reenviado" necesitamos
 * ver el JSON CRUDO completo, no esos 3 campos recortados.
 *
 * Qué hace:
 *   1. Reusa la sesión Playwright guardada (o login fresco SIN guardarla).
 *   2. Resuelve cmid → assignid con core_course_get_contents (get_assignments
 *      suele estar capado en SENA).
 *   3. Llama mod_assign_list_participants y VUELCA el objeto completo de varios
 *      participantes (todas las claves con sus valores).
 *   4. Agrega: claves únicas vistas en TODOS los participantes, distribución de
 *      `submissionstatus`, y marca claves "interesantes" (intento/fecha/reabierto).
 *
 * READ-ONLY: NO escribe DB, NO guarda sesión (no pisa la sesión de los workers).
 *
 * Uso:
 *   node scripts/probe-assign-raw-json.js [email] [courseId] [cmid]
 *   - Sin args: toma el primer usuario con credenciales y autodetecta una ficha
 *     + una evidencia tipo assign desde la DB.
 *   - Ideal: pasar el cmid de un assign donde SEPAS que hubo un reenvío/reapertura,
 *     para ver qué campos cambian en ese aprendiz.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

// Zajuna no envía la cadena completa de certificados (igual que los otros probes).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");
const { resolverAssignInfo } = require("../scraper/evidencias");

// Claves que, si existen, habilitan "reenviado" (intento) o lo enriquecen.
const CLAVES_INTERESANTES = /attempt|intento|time|fecha|reopen|reabr|extension|duedate|grade|version|modified|status/i;

async function callAjax(page, sesskey, methodname, args) {
  return await page.evaluate(async ({ base, sesskey, methodname, args }) => {
    const url = `${base}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${encodeURIComponent(methodname)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify([{ index: 0, methodname, args }]),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, raw: json ? null : text.slice(0, 400) };
  }, { base: BASE_URL, sesskey, methodname, args });
}

// El AJAX de Moodle envuelve la respuesta en [{ error, data | exception }].
function desempaquetar(r) {
  if (!r || !r.json) return { ok: false, motivo: `HTTP ${r?.status} sin JSON: ${r?.raw || ""}` };
  const item = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!item) return { ok: false, motivo: "respuesta vacía" };
  if (item.error) {
    const ex = item.exception || {};
    return { ok: false, motivo: `${ex.errorcode || "error"}: ${ex.message || JSON.stringify(item).slice(0, 200)}` };
  }
  return { ok: true, data: item.data };
}

async function main() {
  const emailArg    = process.argv[2] || null;
  let   courseIdArg = process.argv[3] || null;
  let   cmidArg     = process.argv[4] || null;

  const user = await prisma.user.findFirst({
    where:  emailArg ? { email: emailArg } : undefined,
    select: { id: true, email: true, zajunaUserEnc: true, zajunaPassEnc: true },
  });
  if (!user) { console.error("✖ No hay usuario con credenciales."); process.exit(1); }
  console.log(`→ Usuario: ${user.email}`);

  // Autodetectar ficha + evidencia assign si no vinieron por args.
  let fichaCodigo = null;
  if (!courseIdArg) {
    const ficha = await prisma.ficha.findFirst({
      where:  { userId: user.id, archivedAt: null },
      select: { id: true, courseId: true, codigo: true },
    });
    if (!ficha) { console.error("✖ No hay fichas con courseId para este usuario."); process.exit(1); }
    courseIdArg = ficha.courseId;
    fichaCodigo = ficha.codigo;
    if (!cmidArg) {
      const ev = await prisma.evidencia.findFirst({
        where:  { fichaId: ficha.id, tipo: "assign" },
        select: { nombre: true, href: true },
      });
      if (ev) {
        cmidArg = (ev.href.match(/[?&]id=(\d+)/) || [])[1] || null;
        console.log(`→ Evidencia assign de muestra: "${ev.nombre}"  (cmid=${cmidArg})`);
      }
    }
  }
  console.log(`→ courseId=${courseIdArg}${fichaCodigo ? ` (ficha ${fichaCodigo})` : ""}  cmid=${cmidArg || "(ninguno)"}\n`);

  const saved = await loadSession(user.id);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(saved ? { storageState: saved } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    let ok = false;
    if (saved) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      ok = page.url().includes("/zajuna/") && !page.url().includes("/login");
    }
    if (!ok) {
      console.log("→ Sesión guardada inválida/ausente: login fresco (no se guarda).");
      await login(page, decrypt(user.zajunaUserEnc), decrypt(user.zajunaPassEnc));
    } else {
      console.log("→ Reusando sesión guardada ✓");
    }

    // Tras un login FRESCO la página de aterrizaje (/my/courses.php) a veces no
    // tiene window.M poblado todavía → navegamos a /my/ y esperamos para que el
    // config JS de Moodle (con el sesskey) esté cargado.
    await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await cerrarModal(page);
    let sesskey = await page.evaluate(() => (window.M && window.M.cfg && window.M.cfg.sesskey) || null);
    if (!sesskey) {
      // Fallback: el sesskey va incrustado en los links de logout y en el JS.
      const html = await page.content();
      const m = html.match(/sesskey["'=:\s]+([A-Za-z0-9]{6,})/);
      sesskey = m ? m[1] : null;
    }
    console.log(`\n[1] sesskey: ${sesskey ? sesskey.slice(0, 6) + "…" : "✖ NO ENCONTRADO"}`);
    if (!sesskey) { console.log("    Sin sesskey no se puede llamar al AJAX. Aborto."); return; }

    // Resolver cmid → assignid leyendo el grader HTML (igual que el worker real).
    // OJO: core_course_get_contents / mod_assign_get_assignments están CAPADOS en
    // SENA (servicenotavailable); por eso se usa resolverAssignInfo (data-assignmentid).
    console.log(`\n[2] Resolviendo cmid → assignid (grader HTML, resolverAssignInfo)…`);
    if (!cmidArg) { console.log("    ✖ Sin cmid no puedo resolver assignid. Aborto."); return; }
    const { assignId: assignid, contextId } = await resolverAssignInfo(page, cmidArg);
    console.log(`    → cmid ${cmidArg} → assignid=${assignid ?? "null"}  contextId=${contextId ?? "null"}`);
    if (!assignid) { console.log("    ✖ No se pudo resolver assignid del grader HTML. Aborto."); return; }

    // mod_assign_list_participants con TODOS los campos.
    console.log(`\n[3] mod_assign_list_participants(assignid=${assignid}) — JSON CRUDO`);
    const r3 = await callAjax(page, sesskey, "mod_assign_list_participants", {
      assignid: Number(assignid),
      groupid: 0, filter: "", skip: 0, limit: 0,
      onlyids: false, includeenrolments: true, tablesort: false,
    });
    const d3 = desempaquetar(r3);
    if (!d3.ok) { console.log(`    ⚠️  ${d3.motivo}`); return; }

    const parts = Array.isArray(d3.data) ? d3.data : [];
    console.log(`    ✅ ${parts.length} participantes.\n`);

    // (a) Claves únicas en TODO el conjunto + marca de "interesantes".
    const todasLasClaves = new Set();
    parts.forEach(p => Object.keys(p || {}).forEach(k => todasLasClaves.add(k)));
    const claves = [...todasLasClaves].sort();
    console.log(`[3a] Claves presentes en los participantes (${claves.length}):`);
    claves.forEach(k => {
      const marca = CLAVES_INTERESANTES.test(k) ? "  ⭐ (posible señal de intento/fecha/reabierto)" : "";
      console.log(`     - ${k}${marca}`);
    });

    // (b) Distribución de submissionstatus (confirma si "draft"/"reopened" aparecen).
    const dist = {};
    parts.forEach(p => { const s = (p && p.submissionstatus) ?? "(ausente)"; dist[s] = (dist[s] || 0) + 1; });
    console.log(`\n[3b] Distribución de submissionstatus:`);
    Object.entries(dist).forEach(([s, n]) => console.log(`     ${String(s).padEnd(14)} ${n}`));

    // (c) Volcado CRUDO de hasta 5 participantes representativos:
    //     prioriza los que NO sean "new" (los que tienen actividad real).
    const conActividad = parts.filter(p => p && p.submissionstatus && p.submissionstatus !== "new");
    const muestra = (conActividad.length ? conActividad : parts).slice(0, 5);
    console.log(`\n[3c] Volcado crudo de ${muestra.length} participante(s) con actividad:`);
    muestra.forEach((p, i) => {
      console.log(`\n   ── participante ${i + 1} ──`);
      console.log(JSON.stringify(p, null, 2));
    });

    console.log(`\n=== Qué buscar en el volcado ===`);
    console.log(`• ¿Hay alguna clave ⭐ con número de intento (attemptnumber / attempt) o fecha (timemodified)?`);
    console.log(`  → SÍ: "reenviado" es derivable (intento > 1, o modificado después de calificar).`);
    console.log(`  → NO: "reenviado" NO se puede del AJAX; tocaría DOM por assign (lento) o descartarlo.`);
    console.log(`• ¿Aparece submissionstatus="draft"? → confirma que "borrador" es capturable tal cual.`);
    console.log(`• ¿"reopened" trae además algún contador de intento? → distingue "reabierto" de "ya reenvió".`);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("✖ Error fatal:", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 4).join("\n"));
  await prisma.$disconnect();
  process.exit(1);
});
