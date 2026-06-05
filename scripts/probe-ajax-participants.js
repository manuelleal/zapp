/**
 * scripts/probe-ajax-participants.js
 *
 * PROBE de decisión para la CAPA 2 del scan de evidencias.
 *
 * Pregunta que responde: ¿podemos cargar las entregas de un `assign` vía el
 * AJAX interno de Moodle (`/lib/ajax/service.php` con el `sesskey` de la sesión
 * ya autenticada), en vez de raspar el DOM de `view.php?action=grading`?
 * Es el "Camino 2" que usa la Extensión Z (ver docs/MOODLE_REFERENCE.md).
 *
 * Prueba en orden:
 *   1. Extrae el sesskey de la página (window.M.cfg.sesskey).
 *   2. mod_assign_get_assignments(courseid)  → mapa cmid → assignid + fechas.
 *   3. mod_assign_list_participants(assignid) → participantes con submitted /
 *      requiregrading / isSuspended.
 *   4. Repite (3) pasando el cmid en vez del assignid, para ver si el endpoint
 *      acepta cualquiera de los dos.
 *
 * READ-ONLY: NO escribe en la DB y NO guarda la sesión (no llama a saveSession),
 * para no pisar la sesión compartida que usan los workers.
 *
 * Uso:
 *   node scripts/probe-ajax-participants.js [email] [courseId] [cmid]
 *   - Sin args: toma el primer usuario con credenciales y autodetecta una
 *     ficha + una evidencia tipo assign desde la DB.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

// Zajuna no envía la cadena completa de certificados; igual que probe-ws-token.
// (El fetch real corre dentro del browser, pero por si algo toca Node lo dejamos.)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");

/**
 * Llama al AJAX interno de Moodle DESDE la página (hereda cookies de sesión).
 * Devuelve { status, json, raw }.
 */
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

  // --- Sesión Playwright (reusar la guardada; si no, login SIN guardar) ---
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
      console.log("→ Sesión guardada inválida/ausente: haciendo login fresco (no se guarda).");
      await login(page, decrypt(user.zajunaUserEnc), decrypt(user.zajunaPassEnc));
    } else {
      console.log("→ Reusando sesión guardada ✓");
    }

    // 1) sesskey
    const sesskey = await page.evaluate(() => (window.M && window.M.cfg && window.M.cfg.sesskey) || null);
    console.log(`\n[1] sesskey: ${sesskey ? sesskey.slice(0, 6) + "…(" + sesskey.length + " chars)" : "✖ NO ENCONTRADO"}`);
    if (!sesskey) { console.log("    Sin sesskey no se puede llamar al AJAX. Aborto."); return; }

    // 2) Resolver cmid → assignid. mod_assign_get_assignments suele estar capado
    //    en SENA, así que probamos core_course_get_contents (mapea cmid→instance).
    console.log(`\n[2] Resolviendo cmid → assignid…`);
    let assignidParaProbar = null;

    console.log(`    [2a] mod_assign_get_assignments(courseid=${courseIdArg})`);
    const r2a = await callAjax(page, sesskey, "mod_assign_get_assignments", {
      courseids: [Number(courseIdArg)], capabilities: [], includenotenrolledcourses: false,
    });
    const d2a = desempaquetar(r2a);
    if (d2a.ok) {
      const assigns = (d2a.data?.courses || [])[0]?.assignments || [];
      console.log(`         ✅ ${assigns.length} assignments vía get_assignments.`);
      const match = cmidArg ? assigns.find(a => String(a.cmid) === String(cmidArg)) : null;
      assignidParaProbar = match ? match.id : (assigns[0]?.id ?? null);
    } else {
      console.log(`         ⚠️  ${d2a.motivo}`);
    }

    if (!assignidParaProbar) {
      console.log(`    [2b] core_course_get_contents(courseid=${courseIdArg})`);
      const r2b = await callAjax(page, sesskey, "core_course_get_contents", {
        courseid: Number(courseIdArg), options: [],
      });
      const d2b = desempaquetar(r2b);
      if (d2b.ok) {
        const secciones = Array.isArray(d2b.data) ? d2b.data : [];
        let totalMods = 0, assignMods = 0;
        let match = null;
        for (const sec of secciones) {
          for (const mod of (sec.modules || [])) {
            totalMods++;
            if (mod.modname === "assign") assignMods++;
            if (cmidArg && String(mod.id) === String(cmidArg)) match = mod;
          }
        }
        console.log(`         ✅ ${secciones.length} secciones, ${totalMods} módulos (${assignMods} assign).`);
        if (match) {
          assignidParaProbar = match.instance;
          console.log(`         → cmid ${cmidArg} (${match.modname}) mapea a instance=assignid ${match.instance}`);
        } else {
          console.log(`         (no encontré el cmid ${cmidArg} en el contenido; tomo el primer assign)`);
          for (const sec of secciones) {
            const a = (sec.modules || []).find(m => m.modname === "assign");
            if (a) { assignidParaProbar = a.instance; cmidArg = String(a.id); break; }
          }
        }
      } else {
        console.log(`         ⚠️  ${d2b.motivo}`);
      }
    }

    // 3) mod_assign_list_participants con el assignid (instance id)
    if (assignidParaProbar) {
      console.log(`\n[3] mod_assign_list_participants(assignid=${assignidParaProbar})`);
      const r3 = await callAjax(page, sesskey, "mod_assign_list_participants", {
        assignid: Number(assignidParaProbar),
        groupid: 0,
        filter: "",
        skip: 0,
        limit: 0,
        onlyids: false,
        includeenrolments: true,
        tablesort: false,
      });
      const d3 = desempaquetar(r3);
      if (!d3.ok) {
        console.log(`    ⚠️  ${d3.motivo}`);
      } else {
        const parts = Array.isArray(d3.data) ? d3.data : [];
        console.log(`    ✅ ${parts.length} participantes. Campos del primero con datos:`);
        const p = parts.find(x => x && x.id) || parts[0];
        if (p) {
          const campos = ["id", "fullname", "submitted", "requiregrading", "submissionstatus", "gradingstatus", "grade", "isSuspended", "lastaccesscourse"];
          for (const c of campos) {
            if (c in p) console.log(`       ${c}: ${JSON.stringify(p[c])}`);
          }
          console.log(`    (claves disponibles: ${Object.keys(p).join(", ")})`);
        }
      }
    } else {
      console.log("\n[3] (omitido: no se obtuvo assignid del paso 2)");
    }

    // 4) ¿el endpoint acepta el cmid directo en vez del assignid?
    if (cmidArg) {
      console.log(`\n[4] mod_assign_list_participants(assignid=${cmidArg})  ← probando con el CMID directo`);
      const r4 = await callAjax(page, sesskey, "mod_assign_list_participants", {
        assignid: Number(cmidArg),
        groupid: 0, filter: "", skip: 0, limit: 0, onlyids: false, includeenrolments: true, tablesort: false,
      });
      const d4 = desempaquetar(r4);
      if (!d4.ok) console.log(`    → con cmid falla (${d4.motivo}) ⇒ HAY que mapear cmid→assignid con get_assignments.`);
      else        console.log(`    → con cmid TAMBIÉN funciona (${(d4.data || []).length} participantes) ⇒ el endpoint acepta cmid.`);
    }

    // 5) Barrido de disponibilidad: distinguimos "función deshabilitada"
    //    (servicenotavailable / accessexception) de "función OK pero args malos"
    //    (invalidrecord / invalidparameter) — esto último significa DISPONIBLE.
    console.log(`\n[5] Disponibilidad de funciones AJAX (con args mínimos/dummy):`);
    const candidatas = [
      ["mod_assign_list_participants", { assignid: 1, groupid: 0, filter: "", skip: 0, limit: 1, onlyids: true, includeenrolments: false, tablesort: false }],
      ["mod_assign_get_assignments", { courseids: [Number(courseIdArg)] }],
      ["mod_assign_get_submissions", { assignmentids: [1] }],
      ["mod_assign_get_grades", { assignmentids: [1] }],
      ["core_course_get_contents", { courseid: Number(courseIdArg), options: [] }],
      ["gradereport_user_get_grade_items", { courseid: Number(courseIdArg), userid: 0 }],
      ["core_grades_get_enrolled_users_for_selector", { courseid: Number(courseIdArg), groupid: 0 }],
    ];
    for (const [fn, args] of candidatas) {
      const r = await callAjax(page, sesskey, fn, args);
      const d = desempaquetar(r);
      let veredicto;
      if (d.ok) veredicto = "✅ DISPONIBLE (respondió OK)";
      else if (/servicenotavailable|accessexception|webservice|disabled|nopermission|require_login/i.test(d.motivo)) veredicto = `❌ NO disponible (${d.motivo})`;
      else veredicto = `✅ DISPONIBLE (capada solo por args: ${d.motivo})`;
      console.log(`    ${fn.padEnd(46)} ${veredicto}`);
    }

    console.log("\n=== Veredicto ===");
    console.log("Capa 2 viable si list_participants está ✅ DISPONIBLE y existe un resolver cmid→assignid (get_assignments o core_course_get_contents) también ✅.");
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
