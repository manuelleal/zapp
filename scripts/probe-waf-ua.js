/**
 * scripts/probe-waf-ua.js — Probe de diagnóstico del bloqueo WAF del portal SENA (read-only).
 *
 * Creado 21-jul-2026: tras el mantenimiento del SENA (11-13 jul), el portal
 * https://zajuna.sena.edu.co devuelve "Web Page Blocked!" (Fortinet, Attack ID
 * 20000051) al Chromium headless de Playwright, pero responde 200 a un fetch
 * plano. Hipótesis: el WAF filtra por User-Agent "HeadlessChrome".
 *
 * Prueba 3 variantes y reporta si cada una ve el portal real o el bloqueo:
 *   A. Chromium headless por defecto (lo que usan los workers hoy).
 *   B. Igual + User-Agent de Chrome normal (spoofeado en el context).
 *   C. Chromium headed (headless:false) sin tocar UA.
 *
 * Read-only: no loguea, no escribe DB. Uso: node scripts/probe-waf-ua.js
 */
const { chromium } = require("playwright");

const UA_NORMAL =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function probar(nombre, launchOpts, ctxOpts) {
  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
    const page = await ctx.newPage();
    const uaReal = await page.evaluate(() => navigator.userAgent).catch(() => "(?)");
    await page.goto("https://zajuna.sena.edu.co", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const texto = await page.evaluate(() => (document.body.innerText || "").slice(0, 200));
    const bloqueado = /Web Page Blocked|Attack ID/i.test(texto);
    const tieneForm = (await page.locator('select[name="typeDocument"]').count()) > 0;
    console.log(`\n[${nombre}]`);
    console.log(`  UA enviado : ${uaReal}`);
    console.log(`  Resultado  : ${bloqueado ? "🔴 BLOQUEADO por WAF" : tieneForm ? "🟢 Portal real (form de login presente)" : "🟡 Ni bloqueo ni form — revisar"}`);
    if (!bloqueado && !tieneForm) console.log(`  Texto      : ${texto.replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`\n[${nombre}]\n  🔴 ERROR: ${e.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  await probar("A: headless default (como los workers)", { headless: true }, {});
  await probar("B: headless + UA spoofeado", { headless: true }, { userAgent: UA_NORMAL });
  await probar("C: headed (headless:false)", { headless: false }, {});
})();
