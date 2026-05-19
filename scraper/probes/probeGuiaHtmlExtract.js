/**
 * Navega a cada página de Guía de aprendizaje (mod/page) y extrae el texto
 * completo buscando el bloque "Resultados de aprendizaje a alcanzar:".
 * Confirma si la información está en el HTML o si hay PDFs embebidos.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs   = require("fs");
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

// Patrón SENA: "Resultados de aprendizaje a alcanzar:" + bloque con códigos
const BLOQUE_REGEX  = /Resultados?\s+de\s+aprendizaje\s+a\s+alcanzar\s*[:\n]([\s\S]{0,3000})/i;
const CODIGO_SENA   = /(\d{9})-(\d{2})/g;

async function extraerContenidoPagina(page) {
  return page.evaluate(() => {
    // Texto limpio del contenido principal de Moodle (evitar nav/header)
    const main = document.querySelector("#region-main, .course-content, .box.generalbox, [role='main']");
    const raw  = (main || document.body).innerText || "";
    return raw.replace(/\s+/g, " ").trim();
  });
}

async function main() {
  const ficha = await prisma.ficha.findFirst({
    where: { courseId: { not: 0 }, archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true } } },
  });
  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);
  log(`Ficha: ${ficha.codigo}  courseId=${ficha.courseId}`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  await login(page, zajunaUser, zajunaPass);

  // Lista de guías a inspeccionar: IDs conocidos (incluyendo las sin número)
  const guiasIds = [
    // Sin número (podrían ser de otras competencias/fases)
    { id: 3515144, etiqueta: "sin-num-A" },
    { id: 3515149, etiqueta: "sin-num-B" },
    { id: 3515154, etiqueta: "sin-num-C" },
    { id: 3515158, etiqueta: "sin-num-D" },
    // Numeradas GA1-GA11
    { id: 3515204, etiqueta: "GA01" },
    { id: 3515253, etiqueta: "GA02" },
    { id: 3515283, etiqueta: "GA03" },
    { id: 3515313, etiqueta: "GA04" },
    { id: 3515339, etiqueta: "GA05" },
    { id: 3515360, etiqueta: "GA06" },
    { id: 3515396, etiqueta: "GA07" },
    { id: 3515413, etiqueta: "GA08" },
    { id: 3515427, etiqueta: "GA09" },
    { id: 3515466, etiqueta: "GA10" },
    { id: 3515513, etiqueta: "GA11" },
  ];

  const resultados = [];

  for (const { id, etiqueta } of guiasIds) {
    const url = `${BASE_URL}/mod/page/view.php?id=${id}`;
    log(`\n── ${etiqueta} (id=${id}) ──`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await cerrarModal(page);

    const titulo = await page.title();
    const texto  = await extraerContenidoPagina(page);
    log(`  Título: ${titulo}`);
    log(`  Texto: ${texto.length} chars`);

    // Buscar bloque RAPs
    const bloqueMatch = texto.match(BLOQUE_REGEX);
    const codigosSena = [];
    if (bloqueMatch) {
      log(`  ✅ BLOQUE "Resultados de aprendizaje" encontrado!`);
      log(`     Contenido (300 chars): "${bloqueMatch[1].substring(0, 300)}"`);
      for (const m of bloqueMatch[1].matchAll(CODIGO_SENA)) {
        codigosSena.push(`${m[1]}-${m[2]}`);
        log(`     Código SENA: ${m[1]}-${m[2]}`);
      }
    } else {
      log(`  ⚠  Bloque NO encontrado.`);
      // Mostrar muestra del texto para diagnóstico
      log(`  Muestra (500 chars): "${texto.substring(0, 500)}"`);
    }

    // Buscar cualquier link de PDF o recurso en la página
    const pdfLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .filter(a => /pluginfile|\.pdf|forcedownload|mod\/resource/i.test(a.href))
        .map(a => ({ texto: (a.textContent || "").substring(0, 60), href: a.href.substring(0, 120) }))
    );
    if (pdfLinks.length > 0) {
      log(`  PDF/resource links en la página:`);
      pdfLinks.forEach(l => log(`    "${l.texto}" → ${l.href}`));
    }

    resultados.push({ id, etiqueta, titulo, textLen: texto.length, tieneBloqueRap: !!bloqueMatch, codigosSena, pdfLinks });
  }

  // Resumen
  console.log("\n\n╔══════════════════════════════════════════════════════╗");
  console.log("║  RESUMEN: ¿Dónde está el bloque de RAPs?              ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  for (const r of resultados) {
    const icon = r.tieneBloqueRap ? "✅" : "  ";
    const pdfs = r.pdfLinks.length > 0 ? ` + ${r.pdfLinks.length} PDF(s)` : "";
    console.log(`║  ${icon} ${r.etiqueta.padEnd(10)} | ${r.titulo.substring(0, 40).padEnd(40)} | ${r.codigosSena.length} códigos${pdfs}`);
  }
  console.log("╚══════════════════════════════════════════════════════╝\n");

  fs.writeFileSync("probe-html-extract.json", JSON.stringify(resultados, null, 2));
  log("Resultado guardado: probe-html-extract.json");

  await browser.close();
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
