/**
 * Inspecciona el HTML raw de la página GA01 para encontrar
 * el elemento "Clic aquí para acceder al recurso educativo".
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs = require("fs");
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

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Capturar PDFs en nueva pestaña
  const pdfsPestana = [];
  ctx.on("page", async (newPage) => {
    await newPage.waitForLoadState("domcontentloaded").catch(() => {});
    const url = newPage.url();
    log(`[nueva-pestaña] URL: ${url}`);
    pdfsPestana.push(url);
    await newPage.screenshot({ path: "probe-pdf-pestana.png", fullPage: true }).catch(() => {});
    await newPage.close().catch(() => {});
  });

  await login(page, zajunaUser, zajunaPass);

  log("\n═══ Inspeccionando GA01 (id=3515204) ═══");
  await page.goto(`${BASE_URL}/mod/page/view.php?id=3515204`, { waitUntil: "domcontentloaded" });
  await cerrarModal(page);

  // 1. Buscar TODOS los elementos con texto "clic" o "acceder"
  const elementosClic = await page.evaluate(() => {
    const results = [];
    // Buscar en todos los elementos del DOM
    document.querySelectorAll("a, button, [onclick], [role='button'], span, p").forEach(el => {
      const t = (el.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (t.includes("clic aquí") || t.includes("haga clic") || t.includes("acceder al recurso") || t.includes("clic here")) {
        results.push({
          tag:     el.tagName,
          texto:   el.textContent.trim().substring(0, 100),
          href:    el.getAttribute("href") || el.getAttribute("data-url") || "",
          onclick: el.getAttribute("onclick") || "",
          class:   el.className || "",
          id:      el.id || "",
          html:    el.outerHTML.substring(0, 300),
        });
      }
    });
    return results;
  });

  log(`\nElementos con "clic aquí" / "acceder al recurso": ${elementosClic.length}`);
  elementosClic.forEach(e => {
    log(`  TAG: ${e.tag}  id="${e.id}"  class="${e.class}"`);
    log(`  texto: "${e.texto}"`);
    log(`  href: "${e.href}"`);
    log(`  onclick: "${e.onclick}"`);
    log(`  HTML: ${e.html}`);
    log("");
  });

  // 2. Guardar HTML completo de la región principal para inspección
  const htmlMain = await page.evaluate(() => {
    const el = document.querySelector("#region-main, .course-content, [role='main']");
    return el ? el.innerHTML : document.body.innerHTML;
  });
  fs.writeFileSync("probe-ga01-main.html", htmlMain);
  log(`\nHTML principal guardado: probe-ga01-main.html (${htmlMain.length} chars)`);

  // 3. Screenshot completa
  await page.screenshot({ path: "probe-ga01-full.png", fullPage: true });
  log("Screenshot: probe-ga01-full.png");

  // 4. Si el PDF abrió en nueva pestaña, reportarlo
  await page.waitForTimeout(2000);
  if (pdfsPestana.length > 0) {
    log(`\n✅ PDFs capturados en pestaña nueva: ${pdfsPestana.join(", ")}`);
  }

  await page.waitForTimeout(5000);
  await browser.close();
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
