/**
 * scripts/probe-calendar-dates.js
 *
 * PROBE de decisión: ¿podemos leer las FECHAS de los assignments (duedate /
 * apertura) por el AJAX interno de Moodle (`/lib/ajax/service.php` + sesskey),
 * SIN wstoken, igual que ya hacemos con mod_assign_list_participants?
 *
 * mod_assign_get_assignments está capada en SENA, pero las funciones de
 * CALENDARIO suelen estar ajax-habilitadas (la timeline y el bloque calendario
 * de Boost las consumen por AJAX). Devuelven "action events" con timestamps,
 * que para un assign son la fecha de ENTREGA (duedate).
 *
 * Prueba, con args reales, estas candidatas:
 *   - core_calendar_get_action_events_by_timesort   (timeline / "próximos")
 *   - core_calendar_get_calendar_monthly_view       (vista mes)
 *   - core_calendar_get_calendar_upcoming_view      (próximos eventos)
 *   - core_calendar_get_calendar_day_view
 *   - core_course_get_contents                      (referencia: ya sabemos que suele estar capada)
 *
 * Para cada una distingue: ✅ disponible y con datos · ✅ disponible pero vacía
 * · ❌ no disponible (servicenotavailable/accessexception). Si alguna trae
 * eventos de tipo assign con su courseid/instance + timestamp, IMPRIME un par
 * de ejemplos para confirmar que sirve para poblar fechas.
 *
 * READ-ONLY: no escribe DB, no guarda sesión.
 *
 * Uso:
 *   node scripts/probe-calendar-dates.js [email] [courseId]
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");

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

function disponibilidad(d) {
  if (d.ok) return "ok";
  if (/servicenotavailable|accessexception|webservice|disabled|nopermission|require_login/i.test(d.motivo)) return "no";
  return "args"; // disponible, solo falló por argumentos
}

// Recorre cualquier estructura buscando eventos con pinta de assign + timestamp.
function extraerEventos(data) {
  const out = [];
  const visit = (ev) => {
    if (!ev || typeof ev !== "object") return;
    const ts = ev.timestart || ev.timesort || ev.timeusermidnight;
    const modname = ev.modulename || ev.eventtype;
    if (ts && (ev.name || ev.instance || ev.course)) {
      out.push({
        name: ev.name,
        modname,
        instance: ev.instance,
        courseid: ev.course?.id || ev.courseid,
        timestart: ev.timestart,
        timesort: ev.timesort,
        cmid: ev.cmid || ev.url?.match(/id=(\d+)/)?.[1],
        when: ts ? new Date(ts * 1000).toISOString() : null,
      });
    }
  };
  const events = data?.events || [];
  for (const e of events) visit(e);
  // monthly view: data.weeks[].days[].events[]
  for (const w of (data?.weeks || [])) for (const day of (w.days || [])) for (const e of (day.events || [])) visit(e);
  return out;
}

async function main() {
  const emailArg = process.argv[2] || null;
  let courseIdArg = process.argv[3] || null;

  const user = await prisma.user.findFirst({
    where: emailArg ? { email: emailArg } : undefined,
    select: { id: true, email: true, zajunaUserEnc: true, zajunaPassEnc: true },
  });
  if (!user) { console.error("✖ No hay usuario con credenciales."); process.exit(1); }
  console.log(`→ Usuario: ${user.email}`);

  let fichaCodigo = null;
  if (!courseIdArg) {
    const ficha = await prisma.ficha.findFirst({
      where: { userId: user.id, archivedAt: null },
      select: { courseId: true, codigo: true },
    });
    if (!ficha) { console.error("✖ No hay fichas con courseId."); process.exit(1); }
    courseIdArg = ficha.courseId;
    fichaCodigo = ficha.codigo;
  }
  console.log(`→ courseId=${courseIdArg}${fichaCodigo ? ` (ficha ${fichaCodigo})` : ""}\n`);

  const saved = await loadSession(user.id);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "es-CO", timezoneId: "America/Bogota",
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

    const sesskey = await page.evaluate(() => (window.M && window.M.cfg && window.M.cfg.sesskey) || null);
    console.log(`\n[1] sesskey: ${sesskey ? sesskey.slice(0, 6) + "…(" + sesskey.length + " chars)" : "✖ NO ENCONTRADO"}`);
    if (!sesskey) { console.log("    Sin sesskey no se puede llamar al AJAX. Aborto."); return; }

    const now = Math.floor(Date.now() / 1000);
    const año = new Date().getFullYear();
    const mes = new Date().getMonth() + 1;

    const candidatas = [
      ["core_calendar_get_action_events_by_timesort", {
        timesortfrom: now - 60 * 86400, timesortto: now + 365 * 86400, limitnum: 50, limittononsuspendedevents: true,
      }],
      ["core_calendar_get_action_events_by_course", {
        courseid: Number(courseIdArg), timesortfrom: now - 365 * 86400, limitnum: 50,
      }],
      ["core_calendar_get_calendar_upcoming_view", { courseid: Number(courseIdArg) }],
      ["core_calendar_get_calendar_monthly_view", {
        year: año, month: mes, courseid: Number(courseIdArg), categoryid: 0,
        includenavigation: false, mini: true,
      }],
      ["core_course_get_contents", { courseid: Number(courseIdArg), options: [] }],
    ];

    console.log(`\n[2] Probando funciones de fecha (courseId=${courseIdArg}):\n`);
    for (const [fn, args] of candidatas) {
      const r = await callAjax(page, sesskey, fn, args);
      const d = desempaquetar(r);
      const estado = disponibilidad(d);
      if (estado === "no") {
        console.log(`  ${fn.padEnd(48)} ❌ NO disponible (${d.motivo})`);
        continue;
      }
      if (estado === "args") {
        console.log(`  ${fn.padEnd(48)} ✅ DISPONIBLE (falló solo por args: ${d.motivo})`);
        continue;
      }
      const eventos = extraerEventos(d.data);
      const assigns = eventos.filter(e => /assign/i.test(e.modname || ""));
      console.log(`  ${fn.padEnd(48)} ✅ OK — ${eventos.length} eventos (${assigns.length} assign)`);
      for (const e of (assigns.length ? assigns : eventos).slice(0, 3)) {
        console.log(`        · ${(e.name || "?").slice(0, 50).padEnd(50)} mod=${e.modname} cmid=${e.cmid || "?"} inst=${e.instance || "?"} → ${e.when}`);
      }
    }

    console.log("\n=== Veredicto ===");
    console.log("Si alguna calendar fn devuelve eventos assign con cmid/instance + timestamp,");
    console.log("tenemos las fechas de ENTREGA sin token y replicable desde Node con cookies.");
    console.log("(La fecha de APERTURA no la trae el calendario; para esa, scrape del form de edición.)");
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
