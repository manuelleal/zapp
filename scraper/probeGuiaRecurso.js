/**
 * Sigue el link "Clic aquí para acceder al recurso educativo" en cada guía
 * y extrae el texto con el bloque RAP o la URL del PDF.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs   = require("fs");
const { chromium } = require("playwright");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("./auth");
const { decrypt } = require("../api/src/lib/crypto");
const prisma = require("../api/src/db/client");

const BLOQUE_REGEX = /Resultados?\s+de\s+aprendizaje\s+a\s+alcanzar\s*[:\n]([\s\S]{0,3000})/i;
const CODIGO_SENA  = /(\d{9})-(\d{2})\s*[:\-\.\s]+([^\n\d]{15,300})/g;

const GUIAS = [
  { id: 3515204, etiqueta: "GA01" },
  { id: 3515253, etiqueta: "GA02" },
  { id: 3515283, etiqueta: "GA03" },
  { id: 3515313, etiqueta: "GA04" },
  { id: 3515339, etiqueta: "GA05" },
  { id: 3515360, etiqueta: "GA06" },
  { id: 3515396, etiqueta: "GA07" },
];

async function main() {
  const ficha = await prisma.ficha.findFirst({
    where: { courseId: { not: 0 }, archivedAt: null },
    include: { user: { select: { zajunaUserEnc: true, zajunaPassEnc: true } } },
  });
  const zajunaUser = decrypt(ficha.user.zajunaUserEnc);
  const zajunaPass = decrypt(ficha.user.zajunaPassEnc);

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Capturar redirecciones a PDF en nueva pestaña
  const pdfsPestana = [];
  ctx.on("page", async (newPage) => {
    const url = newPage.url();
    if (/pluginfile|\.pdf/i.test(url)) {
      pdfsPestana.push(url);
      log(`[nueva-pestaña] PDF: ${url}`);
    }
    await newPage.close().catch(() => {});
  });

  await login(page, zajunaUser, zajunaPass);

  const resultados = [];

  for (const { id, etiqueta } of GUIAS) {
    log(`\n═══ ${etiqueta} (id=${id}) ═══`);
    const guiaUrl = `${BASE_URL}/mod/page/view.php?id=${id}`;
    await page.goto(guiaUrl, { waitUntil: "domcontentloaded" });
    await cerrarModal(page);

    // Dump completo de TODOS los elementos clickeables para ver qué hay
    const todosElementos = await page.evaluate(() => {
      const res = [];
      document.querySelectorAll("a, button, [onclick]").forEach(el => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().substring(0, 80);
        if (t.length < 2) return;
        res.push({
          tag:     el.tagName,
          texto:   t,
          href:    el.getAttribute("href") || "",
          onclick: (el.getAttribute("onclick") || "").substring(0, 80),
        });
      });
      return res;
    });
    log(`  Elementos clickeables (${todosElementos.length}):`);
    todosElementos.forEach(e => log(`    [${e.tag}] "${e.texto}" href="${e.href}" onclick="${e.onclick}"`));

    // Buscar el botón por atributo onclick que contenga window.open (más directo)
    const btnInfo = await page.evaluate(() => {
      // Primero: cualquier elemento con window.open en su onclick (lo más directo)
      const elOnclick = document.querySelector("[onclick*='window.open']");
      if (elOnclick) {
        return {
          encontrado: true,
          tag:     elOnclick.tagName,
          href:    elOnclick.getAttribute("href") || "",
          onclick: elOnclick.getAttribute("onclick"),           // sin truncar
          texto:   elOnclick.textContent.trim().substring(0, 80),
          metodo:  "onclick-attr",
        };
      }
      // Fallback: buscar por texto en cualquier elemento
      const textos = ["clic aquí", "haga clic", "acceder al recurso"];
      for (const el of document.querySelectorAll("a, button, [onclick], span")) {
        const t = (el.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
        if (textos.some(x => t.includes(x))) {
          let onclickFull = el.getAttribute("onclick") || "";
          if (!onclickFull) {
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
              onclickFull = parent.getAttribute("onclick") || "";
              if (onclickFull) break;
              parent = parent.parentElement;
            }
          }
          return { encontrado: true, tag: el.tagName, href: el.getAttribute("href") || "", onclick: onclickFull, texto: el.textContent.trim().substring(0, 80), metodo: "texto" };
        }
      }
      return { encontrado: false };
    });

    log(`\n  Botón "Clic aquí": ${btnInfo.encontrado ? `[${btnInfo.tag}] href="${btnInfo.href}" onclick="${btnInfo.onclick.substring(0, 120)}"` : "NO encontrado"}`);

    // Extraer URL del window.open('...') en onclick
    let windowOpenUrl = null;
    if (btnInfo.onclick) {
      const m = btnInfo.onclick.match(/window\.open\s*\(\s*['"]([^'"]+)['"]/i);
      if (m) {
        windowOpenUrl = m[1];
        // Si es path relativo, prefijarlo con la raíz del servidor (sin /zajuna)
        if (windowOpenUrl.startsWith("/") && !windowOpenUrl.startsWith("//")) {
          windowOpenUrl = "https://zajuna.sena.edu.co" + windowOpenUrl;
        }
        log(`  window.open URL: ${windowOpenUrl}`);
      }
    }

    let pdfUrl = null;
    let textoRecurso = "";
    let codigosSena  = [];

    // Estrategia principal: navegar directamente a la URL del window.open
    if (windowOpenUrl) {
      log(`  Navegando a window.open URL...`);
      await page.goto(windowOpenUrl, { waitUntil: "domcontentloaded" });
      pdfUrl = page.url();
      log(`  URL final: ${pdfUrl}`);
      await page.screenshot({ path: `probe-recurso-${etiqueta.toLowerCase()}-windowopen.png` }).catch(() => {});
    } else if (btnInfo.encontrado) {
      // Fallback: clic real + captura nueva pestaña
      log(`  Sin window.open, intentando clic real + nueva pestaña...`);
      const [newPage] = await Promise.all([
        ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null),
        page.evaluate(() => {
          const textos = ["clic aquí", "haga clic", "acceder al recurso"];
          for (const el of document.querySelectorAll("a, button, [onclick], span")) {
            const t = (el.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
            if (textos.some(x => t.includes(x))) { el.click(); return true; }
          }
          return false;
        }),
      ]);
      if (newPage) {
        await newPage.waitForLoadState("domcontentloaded").catch(() => {});
        pdfUrl = newPage.url();
        log(`  ✅ Nueva pestaña: ${pdfUrl}`);
        await newPage.screenshot({ path: `probe-recurso-${etiqueta.toLowerCase()}-pestana.png` }).catch(() => {});
        await newPage.close().catch(() => {});
      } else {
        pdfUrl = page.url();
        log(`  Misma pestaña: ${pdfUrl}`);
      }
    }

    // Fallback: usar el href si existe
    if (!pdfUrl && btnInfo.href && !/^#|^javascript/i.test(btnInfo.href)) {
      log(`  Intentando href directo: ${btnInfo.href}`);
      await page.goto(btnInfo.href, { waitUntil: "domcontentloaded" });
      pdfUrl = page.url();
      log(`  URL tras goto: ${pdfUrl}`);
    }

    // Si la URL apunta a un PDF, descargarlo con las cookies de sesión y parsearlo
    if (pdfUrl && /\.pdf/i.test(pdfUrl)) {
      log(`  Descargando PDF: ${pdfUrl}`);
      const cookies = await ctx.cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

      let pdfBuffer;
      // Descarga con https module — rejectUnauthorized:false por certificado SENA no confiable
      const https = require("https");
      try {
        pdfBuffer = await new Promise((resolve, reject) => {
          const agent = new https.Agent({ rejectUnauthorized: false });
          const options = {
            method: "GET",
            headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0" },
            agent,
          };
          https.get(pdfUrl, options, (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          }).on("error", reject);
        });
        log(`  PDF descargado: ${pdfBuffer.length} bytes`);
      } catch (err) {
        log(`  ⚠ https.get error: ${err.message}`);
      }
      if (pdfBuffer) {
        fs.writeFileSync(`probe-recurso-${etiqueta.toLowerCase()}.pdf`, pdfBuffer);
        log(`  Guardado: probe-recurso-${etiqueta.toLowerCase()}.pdf`);
      }

      if (pdfBuffer) {
        // pdf-parse v2: new PDFParse({ data: Uint8Array }).getText() → TextResult.text
        const { PDFParse } = require("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
        const data = await parser.getText().catch(err => { log(`  ⚠ pdf-parse error: ${err.message}`); return null; });
        await parser.destroy().catch(() => {});
        if (data) {
          textoRecurso = data.text;
          log(`  PDF parseado: ${textoRecurso.length} chars, ${data.numpages} páginas`);
          log(`  Muestra (600): "${textoRecurso.substring(0, 600).replace(/\n/g, "↵")}"`);

          const bloqueMatch = textoRecurso.match(BLOQUE_REGEX);
          if (bloqueMatch) {
            log(`  ✅ BLOQUE RAP ENCONTRADO!`);
            log(`  Bloque (800): "${bloqueMatch[1].substring(0, 800).replace(/\n/g, "↵")}"`);
            for (const m of bloqueMatch[1].matchAll(CODIGO_SENA)) {
              const descripcion = m[3].trim();
              log(`  → ${m[1]}-${m[2]}: "${descripcion.substring(0, 100)}"`);
              codigosSena.push({ codigo: `${m[1]}-${m[2]}`, competencia: m[1], rapNum: parseInt(m[2], 10), descripcion });
            }
          } else {
            log(`  ⚠ Bloque RAP NO encontrado en el PDF.`);
            // Buscar variaciones del encabezado para diagnóstico
            const variantes = textoRecurso.match(/Resultado[s]?\s+de\s+aprendizaje/gi) || [];
            log(`  Variantes "Resultado(s) de aprendizaje": ${variantes.length} ocurrencias`);
            // Mostrar secciones con códigos SENA \d{9}-\d{2}
            const codigos = [...textoRecurso.matchAll(/(\d{9})-(\d{2})/g)];
            log(`  Códigos SENA encontrados sin bloque: ${codigos.map(m => `${m[1]}-${m[2]}`).join(", ")}`);
          }
        }
      }
    } else if (pdfUrl) {
      // URL no es PDF — leer texto de la página (resource viewer HTML)
      textoRecurso = await page.evaluate(() => {
        const el = document.querySelector("#region-main, .resourcecontent, .generalbox, [role='main']");
        return (el || document.body).innerText.replace(/\s+/g, " ").trim();
      });
      log(`  Texto en página HTML: ${textoRecurso.length} chars`);
      const bloqueMatch = textoRecurso.match(BLOQUE_REGEX);
      if (bloqueMatch) {
        for (const m of bloqueMatch[1].matchAll(CODIGO_SENA)) {
          codigosSena.push({ codigo: `${m[1]}-${m[2]}`, competencia: m[1], rapNum: parseInt(m[2], 10), descripcion: m[3].trim() });
        }
      }
    }

    await page.screenshot({ path: `probe-recurso-${etiqueta.toLowerCase()}.png` });
    resultados.push({ etiqueta, pdfUrl, codigosSena, bloqueEncontrado: codigosSena.length > 0, textoMuestra: textoRecurso.substring(0, 400) });
  }

  // Guardar
  fs.writeFileSync("probe-recurso-resultado.json", JSON.stringify(resultados, null, 2));

  // Resumen
  console.log("\n\n╔══════════════════════════════════════════╗");
  console.log("║  RESUMEN — Recursos de Guías              ║");
  console.log("╠══════════════════════════════════════════╣");
  for (const r of resultados) {
    const icon = r.bloqueEncontrado ? "✅" : (r.pdfUrl ? "📄" : "  ");
    const info = r.codigosSena?.length > 0
      ? `${r.codigosSena.length} código(s) SENA`
      : (r.pdfUrl ? "PDF directo" : "sin descripción");
    console.log(`║  ${icon} ${r.etiqueta.padEnd(6)} | ${info}`);
  }
  console.log("╚══════════════════════════════════════════╝\n");

  await page.waitForTimeout(3000);
  await browser.close();
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
