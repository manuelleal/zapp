/**
 * Probe rápido: escanea el DOM del curso buscando mod/resource y secciones de actividad.
 * Identifica dónde están los PDFs de las Guías de aprendizaje.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

async function main() {
  const ficha = await prisma.ficha.findFirst({
    where: { courseId: { not: 0 }, archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true } } },
  });
  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  log(`Ficha: ${ficha.codigo}  courseId=${ficha.courseId}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  await login(page, zajunaUser, zajunaPass);

  // Cargar el curso
  await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, { waitUntil: "domcontentloaded" });
  await cerrarModal(page);

  // 1. Buscar mod/resource
  const resources = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .filter(a => /mod\/resource\/view/i.test(a.href))
      .map(a => ({ texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80), href: a.href.substring(0, 130) }))
  );

  // 2. Buscar pluginfile
  const pluginfiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .filter(a => /pluginfile/i.test(a.href))
      .map(a => ({ texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80), href: a.href.substring(0, 130) }))
  );

  // 3. Secciones visibles con nombre "Actividad de aprendizaje" o "Guía"
  const secciones = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .filter(a => /(actividad\s+de\s+aprendizaje|gu[íi]a\s+de\s+aprendizaje|material\s+de\s+formaci)/i.test(a.textContent || ""))
      .map(a => ({ texto: (a.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80), href: a.href.substring(0, 130) }))
      .slice(0, 50)
  );

  console.log(`\nmod/resource links: ${resources.length}`);
  resources.forEach(r => console.log(`  "${r.texto}"  →  ${r.href}`));

  console.log(`\npluginfile links: ${pluginfiles.length}`);
  pluginfiles.slice(0, 20).forEach(r => console.log(`  "${r.texto}"  →  ${r.href}`));

  console.log(`\nSecciones relevantes: ${secciones.length}`);
  secciones.forEach(r => console.log(`  "${r.texto}"  →  ${r.href}`));

  await browser.close();
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
