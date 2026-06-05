/**
 * PROBE de SEGURIDAD DE ADJUNTOS: ¿el guardado por fetch borra los archivos del
 * enunciado (anexo / instrumento de evaluación)?
 *
 * Cuenta los enlaces de archivo (pluginfile.php) del enunciado del assign ANTES
 * y DESPUÉS de un guardado por fetch (re-posteo de la fecha actual → dispara el
 * POST completo, incluido el área de borrador de archivos). Si el conteo baja,
 * el guardado por fetch ESTÁ borrando adjuntos.
 *
 * Reversible: guarda la MISMA fecha de entrega que ya tiene (no cambia datos).
 * Uso: node scripts/probe-attach-safety.js <cmid>
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession, saveSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");
const { enableEditMode } = require("../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch, guardarConfigEvidenciaFetch } = require("../scraper/configEvidenciasFetch");
const { Agent } = require("undici");
const ag = new Agent({ connect: { rejectUnauthorized: false } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Cuenta enlaces de archivo del enunciado en la página view.php del assign.
async function contarArchivos(cookieStr, cmid) {
  const res = await fetch(`${BASE_URL}/mod/assign/view.php?id=${cmid}`, {
    headers: { Cookie: cookieStr, "User-Agent": UA }, redirect: "follow", dispatcher: ag,
  });
  const html = await res.text();
  const pluginfiles = (html.match(/pluginfile\.php/g) || []).length;
  const anexos = (html.match(/Clic aqu[ií] para acceder/gi) || []).length;
  return { pluginfiles, anexos };
}

async function main() {
  const cmid = process.argv[2];
  if (!cmid) { console.error("Uso: node scripts/probe-attach-safety.js <cmid>"); process.exit(1); }

  const ev = await prisma.evidencia.findFirst({ where: { href: { contains: `id=${cmid}` } }, select: { nombre: true, ficha: { select: { userId: true, courseId: true } } } });
  if (!ev) { console.error("No encontré evidencia con cmid " + cmid); process.exit(1); }
  console.log(`→ "${ev.nombre}" cmid=${cmid} course=${ev.ficha.courseId}\n`);
  const userId = ev.ficha.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { zajunaUserEnc: true, zajunaPassEnc: true } });

  let st = await loadSession(userId);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota", ...(st ? { storageState: st } : {}) });
  const page = await ctx.newPage(); page.setDefaultTimeout(TIMEOUT);
  try {
    let ok = false;
    if (st) { await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30000 }); await cerrarModal(page); ok = !page.url().includes("/login"); }
    if (!ok) { await login(page, decrypt(user.zajunaUserEnc), decrypt(user.zajunaPassEnc)); st = await ctx.storageState(); await saveSession(userId, st).catch(()=>{}); }
    await enableEditMode(page, ev.ficha.courseId);
    const cookieStr = cookieHeaderFromState(st);

    const antes = await contarArchivos(cookieStr, cmid);
    console.log(`[ANTES]  pluginfile.php=${antes.pluginfiles}  "Clic aquí…"=${antes.anexos}`);
    if (antes.pluginfiles === 0 && antes.anexos === 0) {
      console.log("⚠️ Esta evidencia no parece tener archivos en el enunciado; elige otra cmid con adjuntos.");
    }

    const cfg = await leerConfigEvidenciaFetch(cookieStr, cmid);
    if (!cfg.entregaFecha) { console.log("Sin fecha de entrega; uso apertura para forzar el POST."); }
    const campo = cfg.entregaFecha ? { entregaFecha: cfg.entregaFecha, entregaHora: cfg.entregaHora } : { abrirFecha: cfg.abrirFecha, abrirHora: cfg.abrirHora };
    console.log(`\n[GUARDAR] re-posteo la MISMA fecha: ${JSON.stringify(campo)}`);
    await guardarConfigEvidenciaFetch(cookieStr, cmid, campo);

    const despues = await contarArchivos(cookieStr, cmid);
    console.log(`[DESPUÉS] pluginfile.php=${despues.pluginfiles}  "Clic aquí…"=${despues.anexos}`);

    console.log(`\n=== VEREDICTO ===`);
    if (despues.pluginfiles >= antes.pluginfiles && despues.anexos >= antes.anexos) {
      console.log("✅ Los archivos del enunciado SOBREVIVIERON. El guardado por fetch NO borra adjuntos.");
    } else {
      console.log("🔴 SE PERDIERON ARCHIVOS. El guardado por fetch borra adjuntos → NO mergear save sin arreglar.");
    }
  } finally { await browser.close(); await prisma.$disconnect(); }
}
main().catch(async e => { console.error("✖", e.message); await prisma.$disconnect(); process.exit(1); });
