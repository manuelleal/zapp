/**
 * scripts/smoke-foro.js — smoke test del nuevo revisarEntregasForo (Sprint 2.5 FIX 1).
 * TEMPORAL: borrar tras validar.
 *
 * Uso:
 *   node scripts/smoke-foro.js [actId] [courseId] [email]
 */

require("dotenv").config();
const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { login } = require("../scraper/auth");
const { revisarEntregasForo } = require("../scraper/evidencias");

const ACT_ID    = process.argv[2] || "3615995";
const COURSE_ID = process.argv[3] || "51083";
const EMAIL     = process.argv[4] || "ddiddimmo@gmail.com";

(async () => {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error(`Usuario ${EMAIL} no existe en DB`);

  const u = decrypt(user.zajunaUserEnc);
  const p = decrypt(user.zajunaPassEnc);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await login(page, u, p);
    console.error(`\n>>> smoke revisarEntregasForo(actId=${ACT_ID}, courseId=${COURSE_ID})`);
    const t0 = Date.now();
    const result = await revisarEntregasForo(page, ACT_ID, COURSE_ID);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    const por = { calificado: 0, pendiente: 0, sin_entregar: 0, otros: 0 };
    for (const r of result) {
      if (por[r.estado] !== undefined) por[r.estado]++;
      else por.otros++;
    }
    console.log("\n========== RESULTADO ==========");
    console.log(`Tiempo: ${dt}s`);
    console.log(`Total: ${result.length}`);
    console.log("Resumen por estado:", por);
    console.log("\nMuestra (primeros 10):");
    for (const r of result.slice(0, 10)) {
      console.log(`  [${r.estado.padEnd(12)}] id=${r.aprendizMoodleId}  ${r.nombre}`);
    }
    console.log("================================\n");
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error("ERROR:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
