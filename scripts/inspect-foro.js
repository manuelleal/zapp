/**
 * scripts/inspect-foro.js — inspección one-shot del HTML de un foro real.
 * TEMPORAL: borrar tras smoke test del FIX 1 del Sprint 2.5.
 *
 * Uso:
 *   node scripts/inspect-foro.js [emailUser] [fichaCodigoSuffix]
 *
 * Defaults: ddiddimmo@gmail.com, sufijo "83" o "84".
 */

require("dotenv").config();
const { chromium } = require("playwright");
const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");
const { login, cerrarModal, BASE_URL } = require("../scraper/auth");

const EMAIL          = process.argv[2] || "ddiddimmo@gmail.com";
const SUFFIX_FILTER  = (process.argv[3] || "83,84").split(",").map((s) => s.trim());
const ACT_ID_OVERRIDE = process.argv[4] || null;

function log(msg) { console.error(`[insp] ${msg}`); }

(async () => {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error(`Usuario ${EMAIL} no existe en DB`);

  const u = decrypt(user.zajunaUserEnc);
  const p = decrypt(user.zajunaPassEnc);
  log(`User loaded. zajunaUser=${u.slice(0, 4)}***`);

  const fichas = await prisma.ficha.findMany({
    where: { userId: user.id, archivedAt: null },
    select: { codigo: true, courseId: true, nombre: true },
  });
  log(`Fichas totales: ${fichas.length}`);

  const candidatas = fichas.filter((f) =>
    SUFFIX_FILTER.some((suf) => f.codigo.endsWith(suf))
  );
  log(`Fichas candidatas (sufijo ${SUFFIX_FILTER.join("/")}): ${candidatas.length}`);
  candidatas.forEach((f) => log(`  - ${f.codigo} | courseId=${f.courseId} | ${f.nombre}`));

  if (!candidatas.length) {
    log("Ninguna ficha con sufijo solicitado. Aborto.");
    await prisma.$disconnect();
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await login(page, u, p);

    for (const ficha of candidatas) {
      log(`\n══════ Ficha ${ficha.codigo} (courseId=${ficha.courseId}) ══════`);
      await page.goto(`${BASE_URL}/course/view.php?id=${ficha.courseId}`, { waitUntil: "load" });
      await cerrarModal(page);

      // Expandir todas las cabeceras "Actividad de aprendizaje"
      const cabeceras = page.locator("a, span").filter({ hasText: "Actividad de aprendizaje" });
      const nCab = await cabeceras.count();
      log(`Cabeceras de actividad encontradas: ${nCab}`);
      for (let i = 0; i < nCab; i++) {
        await cabeceras.nth(i).click().catch(() => {});
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(800);

      // Buscar TODOS los links de foro
      const forumLinks = await page.$$eval(
        'a[href*="/mod/forum/view.php"]',
        (as) => as.map((a) => ({
          texto: (a.textContent || "").replace(/\s+/g, " ").trim(),
          href:  a.href,
        }))
      );
      log(`Links de foro detectados: ${forumLinks.length}`);
      forumLinks.forEach((f) => log(`  • ${f.texto}  → ${f.href}`));

      // Filtrar guía 4 (GA4)
      let ga4 = forumLinks.filter((f) => /GA4/i.test(f.texto));
      log(`Foros de GA4: ${ga4.length}`);
      if (ACT_ID_OVERRIDE) {
        const found = forumLinks.find((f) => f.href.includes(`id=${ACT_ID_OVERRIDE}`));
        if (found) ga4 = [found];
        else log(`Override actId=${ACT_ID_OVERRIDE} no encontrado en este curso`);
      }
      if (!ga4.length) continue;

      const target = ga4[0];
      const m = target.href.match(/[?&]id=(\d+)/);
      const actId = m ? m[1] : null;
      log(`\n>>> INSPECCIONANDO FORO: ${target.texto}\n>>> actId=${actId}\n>>> URL=${target.href}`);

      await page.goto(target.href, { waitUntil: "load" });
      await cerrarModal(page);
      await page.waitForTimeout(1500);

      // Snapshot estructurado
      const dump = await page.evaluate(() => {
        function shortHtml(el, max = 1500) {
          const s = el.outerHTML || "";
          return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
        }
        const body = document.querySelector("#region-main, #page-content, .path-mod-forum");
        const root = body || document.body;
        const tables = Array.from(root.querySelectorAll("table"));
        const discussionRows = Array.from(root.querySelectorAll(
          'tr.discussion, [data-discussionid], tr[data-region="discussion-list-row"]'
        ));
        const discussLinks = Array.from(root.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]'));
        const profileLinks = Array.from(root.querySelectorAll('a[href*="/user/view.php?id="], a[href*="/user/profile.php?id="]'));
        const ratingNodes  = Array.from(root.querySelectorAll('.rating, select[name*="rating"], input[name*="rating"], .ratingnum, .ratinggrade'));

        return {
          url: location.href,
          title: document.title,
          tables: tables.map((t, i) => ({
            i,
            className: t.className,
            id: t.id,
            rows: t.querySelectorAll("tr").length,
          })),
          discussionRowsCount: discussionRows.length,
          firstDiscussionRowHtml: discussionRows[0] ? shortHtml(discussionRows[0], 2000) : null,
          discussLinks: discussLinks.slice(0, 5).map((a) => ({
            href: a.href,
            text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          })),
          profileLinks: profileLinks.slice(0, 5).map((a) => ({
            href: a.href,
            text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
          })),
          ratingNodesCount: ratingNodes.length,
          firstRatingHtml: ratingNodes[0] ? shortHtml(ratingNodes[0], 1000) : null,
          mainHtmlExcerpt: shortHtml(root, 4000),
        };
      });

      console.log("\n========== DUMP FORO ==========");
      console.log(JSON.stringify(dump, null, 2));
      console.log("================================\n");

      // También entrar a la primera discussion para ver dónde aparece el rating
      if (dump.discussLinks.length) {
        const dUrl = dump.discussLinks[0].href;
        log(`Entrando a la 1ª discussion: ${dUrl}`);
        await page.goto(dUrl, { waitUntil: "load" });
        await cerrarModal(page);
        await page.waitForTimeout(1000);

        const discussDump = await page.evaluate(() => {
          function shortHtml(el, max = 2000) {
            const s = el.outerHTML || "";
            return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
          }
          const root  = document.querySelector("#region-main") || document.body;
          const posts = Array.from(root.querySelectorAll(".forumpost, article[id^='p'], .post"));
          const ratings = Array.from(root.querySelectorAll(".rating, select[name*='rating'], input[name*='rating'], .ratingnum, .ratinggrade"));
          const forms = Array.from(root.querySelectorAll("form")).map((f) => ({
            action: f.action, id: f.id, className: f.className,
            inputs: Array.from(f.elements).slice(0, 10).map((el) => ({ name: el.name, type: el.type, value: typeof el.value === "string" ? el.value.slice(0, 40) : null })),
          }));
          return {
            url: location.href,
            postsCount: posts.length,
            firstPostHtml: posts[0] ? shortHtml(posts[0], 2500) : null,
            ratingsCount: ratings.length,
            firstRatingHtml: ratings[0] ? shortHtml(ratings[0], 1200) : null,
            forms,
          };
        });
        console.log("\n========== DUMP DISCUSSION ==========");
        console.log(JSON.stringify(discussDump, null, 2));
        console.log("======================================\n");
      }

      // Solo la primera ficha encontrada
      break;
    }
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error("ERROR:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
