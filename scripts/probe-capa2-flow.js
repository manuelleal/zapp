/**
 * scripts/probe-capa2-flow.js
 *
 * Valida la cadena completa de la CAPA 2 usando las funciones REALES exportadas
 * por scraper/evidencias.js (las mismas que usa evidenciasWorker):
 *   obtenerSesskey → resolverAssignInfo(cmid) → listarParticipantesBatch →
 *   estadoDesdeParticipante.
 *
 * READ-ONLY: no escribe en DB, no guarda sesión.
 *
 * Uso: node scripts/probe-capa2-flow.js [email] [cmid...]
 *   Sin cmid: autodetecta hasta 3 evidencias tipo assign de la primera ficha.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");
const {
  obtenerSesskey, resolverAssignInfo, listarParticipantesBatch, estadoDesdeParticipante,
} = require("../scraper/evidencias");

async function main() {
  const emailArg = process.argv[2] || null;
  const cmidsArg = process.argv.slice(3).filter(Boolean);

  const user = await prisma.user.findFirst({
    where:  emailArg ? { email: emailArg } : undefined,
    select: { id: true, email: true, zajunaUserEnc: true, zajunaPassEnc: true },
  });
  if (!user) { console.error("✖ No hay usuario con credenciales."); process.exit(1); }
  console.log(`→ Usuario: ${user.email}`);

  // Autodetectar assigns si no vinieron por args.
  let assignsDb = [];
  if (cmidsArg.length === 0) {
    const ficha = await prisma.ficha.findFirst({
      where:  { userId: user.id, archivedAt: null },
      select: { id: true, courseId: true, codigo: true },
    });
    if (!ficha) { console.error("✖ Sin fichas."); process.exit(1); }
    console.log(`→ Ficha ${ficha.codigo} (courseId=${ficha.courseId})`);
    const evs = await prisma.evidencia.findMany({
      where:  { fichaId: ficha.id, tipo: "assign" },
      select: { nombre: true, href: true, assignId: true },
      take: 3,
    });
    assignsDb = evs.map(e => ({
      nombre: e.nombre,
      cmid: (e.href.match(/[?&]id=(\d+)/) || [])[1],
      assignIdCacheado: e.assignId,
    })).filter(x => x.cmid);
  } else {
    assignsDb = cmidsArg.map(c => ({ nombre: `(cmid ${c})`, cmid: c, assignIdCacheado: null }));
  }
  console.log(`→ ${assignsDb.length} assign(s) a probar.\n`);

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
      console.log("→ Login fresco (no se guarda).");
      await login(page, decrypt(user.zajunaUserEnc), decrypt(user.zajunaPassEnc));
    } else console.log("→ Reusando sesión guardada ✓");

    const sesskey = await obtenerSesskey(page);
    console.log(`[sesskey] ${sesskey ? sesskey.slice(0, 6) + "…" : "✖ NO"}\n`);
    if (!sesskey) return;

    // 1) Resolver assignId de cada cmid (mide tiempo).
    const conAssign = [];
    for (const a of assignsDb) {
      const t0 = Date.now();
      const info = await resolverAssignInfo(page, a.cmid);
      console.log(`[resolver] cmid=${a.cmid} → assignId=${info.assignId} contextId=${info.contextId}  (${Date.now() - t0}ms)  "${a.nombre.slice(0, 40)}"`);
      if (info.assignId) conAssign.push({ cmid: a.cmid, assignId: info.assignId });
    }
    if (conAssign.length === 0) { console.log("\n✖ No se resolvió ningún assignId — revisar el regex del grader HTML."); return; }

    // 2) Batch list_participants (1 POST para todos).
    console.log(`\n[batch] mod_assign_list_participants × ${conAssign.length} en 1 POST…`);
    const t0 = Date.now();
    const mapa = await listarParticipantesBatch(page, sesskey, conAssign);
    console.log(`[batch] respondió en ${Date.now() - t0}ms\n`);

    // 3) Mapear estados y resumir.
    for (const { cmid } of conAssign) {
      const r = mapa.get(cmid);
      if (!r || r.error) { console.log(`  cmid=${cmid}: ✖ ${r ? r.error : "sin datos"}`); continue; }
      const parts = r.participantes || [];
      const counts = { sin_entregar: 0, pendiente: 0, calificado: 0 };
      for (const p of parts) counts[estadoDesdeParticipante(p)]++;
      console.log(`  cmid=${cmid}: ${parts.length} participantes → calificado=${counts.calificado} pendiente=${counts.pendiente} sin_entregar=${counts.sin_entregar}`);
      const sample = parts.find(p => p.submitted) || parts[0];
      if (sample) {
        console.log(`     ej: ${sample.fullname} | submitted=${sample.submitted} requiregrading=${sample.requiregrading} submissionstatus=${JSON.stringify(sample.submissionstatus)} → ${estadoDesdeParticipante(sample)}`);
      }
    }

    console.log("\n=== Veredicto ===");
    console.log("Si el resolver dio assignId y el batch devolvió participantes con estados coherentes, la Capa 2 está lista.");
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
