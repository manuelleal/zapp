/**
 * PROBE de PARIDAD (read-only): ¿la lectura por fetch+cheerio da lo MISMO que la
 * lectura por Playwright (la confiable) en las mismas evidencias?
 *
 * Compara, por cada evidencia assign de una ficha:
 *   leerConfigEvidencia(page, actId)        ← Playwright (verdad terreno)
 *   leerConfigEvidenciaFetch(cookie, actId) ← fetch + cheerio (lo nuevo)
 *
 * Si todas coinciden → la migración es segura y se pueden cablear los workers.
 * READ-ONLY: no escribe nada.
 *
 * Uso: node scripts/probe-fetch-parity.js [courseId] [maxEvidencias]
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { loadSession, saveSession } = require("../api/src/lib/sessionStore");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../scraper/auth");
const { leerConfigEvidencia, enableEditMode: enableEdit } = require("../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch } = require("../scraper/configEvidenciasFetch");

const CAMPOS = ["tipo", "abrirFecha", "abrirHora", "entregaFecha", "entregaHora", "limiteFecha", "limiteHora", "intentos"];

function diff(a, b) {
  const out = [];
  for (const k of CAMPOS) {
    const va = a?.[k] ?? null, vb = b?.[k] ?? null;
    if (String(va) !== String(vb)) out.push(`${k}: PW=${JSON.stringify(va)} vs FETCH=${JSON.stringify(vb)}`);
  }
  return out;
}

async function main() {
  const courseIdArg = process.argv[2] || null;
  const maxEv = parseInt(process.argv[3] || "8", 10);

  const user = await prisma.user.findFirst({ select: { id: true, email: true, zajunaUserEnc: true, zajunaPassEnc: true } });
  console.log(`→ Usuario: ${user.email}`);

  const ficha = await prisma.ficha.findFirst({
    where: courseIdArg ? { userId: user.id, courseId: Number(courseIdArg) } : { userId: user.id, archivedAt: null },
    select: { id: true, courseId: true, codigo: true },
  });
  if (!ficha) { console.error("✖ No hay ficha."); process.exit(1); }

  const evs = await prisma.evidencia.findMany({
    where: { fichaId: ficha.id, tipo: "assign" },
    select: { nombre: true, href: true }, take: maxEv,
  });
  const items = evs.map(e => ({ nombre: e.nombre, actId: (e.href.match(/[?&]id=(\d+)/) || [])[1] })).filter(e => e.actId);
  console.log(`→ Ficha ${ficha.codigo} (course ${ficha.courseId}) — ${items.length} evidencias assign a comparar\n`);

  let storageState = await loadSession(user.id);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota", ...(storageState ? { storageState } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    let ok = false;
    if (storageState) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      ok = !page.url().includes("/login");
    }
    if (!ok) {
      console.log("→ Login fresco…");
      await login(page, decrypt(user.zajunaUserEnc), decrypt(user.zajunaPassEnc));
      storageState = await ctx.storageState();
      await saveSession(user.id, storageState).catch(() => {});
    } else {
      console.log("→ Reusando sesión ✓");
    }
    const cookieStr = cookieHeaderFromState(storageState);

    // Modo edición (necesario para que modedit devuelva el form)
    await enableEdit(page, ficha.courseId);

    let iguales = 0, distintos = 0, errores = 0;
    for (const it of items) {
      try {
        const pw = await leerConfigEvidencia(page, it.actId);
        const ft = await leerConfigEvidenciaFetch(cookieStr, it.actId);
        const d = diff(pw, ft);
        if (d.length === 0) {
          iguales++;
          console.log(`  ✅ ${it.nombre.slice(0, 45).padEnd(45)} idéntico`);
        } else {
          distintos++;
          console.log(`  ⚠️  ${it.nombre.slice(0, 45).padEnd(45)} DIFERENCIAS:`);
          for (const line of d) console.log(`        ${line}`);
        }
      } catch (e) {
        errores++;
        console.log(`  ✖ ${it.nombre.slice(0, 45).padEnd(45)} error: ${e.message}`);
      }
    }

    console.log(`\n=== RESULTADO: ${iguales} idénticas · ${distintos} con diferencias · ${errores} errores ===`);
    if (distintos === 0 && errores === 0) {
      console.log("✅ PARIDAD TOTAL — la lectura por fetch+cheerio es segura. Cablear workers.");
    } else if (distintos > 0) {
      console.log("⚠️ Hay diferencias — revisar (probable disabledIf/JS). NO cablear aún.");
    }
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("✖ Error fatal:", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  await prisma.$disconnect();
  process.exit(1);
});
