const { chromium } = require("playwright");

// ─── BROWSER CHROMIUM COMPARTIDO POR PROCESO ──────────────────────────────────
// Antes cada job hacia su propio chromium.launch() (~1-2s y ~150-300MB c/u);
// con ~19 jobs simultaneos eran ~19 browsers = 3-6GB solo de navegadores y la
// causa real del OOM (CLAUDE.md 11.1). Ahora hay UN browser long-lived por
// proceso de worker y cada job abre un CONTEXT (pocos MB) que cierra al terminar.
//
// IMPORTANTE: nunca llamar browser.close() desde un job — eso mataria el browser
// compartido y romperia todos los jobs concurrentes. Los jobs solo manejan su
// context via acquireContext()/releaseContext().

const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];

// Bloqueo de recursos inutiles: en cada navegacion Moodle descarga
// imagenes/CSS/fuentes/media que el scraper nunca usa. Abortarlos reduce ancho
// de banda y RAM (CLAUDE.md 11.1 / 11.3 P0 #3). NO se bloquean document/script/
// xhr/fetch (Moodle los necesita; el AJAX de Capa 2 va por fetch).
// Kill-switch: BROWSER_BLOCK_RESOURCES=0 lo desactiva sin tocar codigo, por si
// el portal SSO de SENA fallara con recursos bloqueados.
const BLOCK_RESOURCES = process.env.BROWSER_BLOCK_RESOURCES !== "0";
const BLOCKED_TYPES   = new Set(["image", "stylesheet", "font", "media", "other"]);

// Cap global de contexts concurrentes. Aunque el browser se comparta, cada
// context consume RAM; este semaforo limita cuantos viven a la vez en el
// proceso (CLAUDE.md 11.3 P0 #4). Ajustable via BROWSER_MAX_CONTEXTS.
const MAX_CONTEXTS = Number(process.env.BROWSER_MAX_CONTEXTS) || 10;
let activeContexts = 0;

// ─── UA CAMUFLADO (anti-WAF) ──────────────────────────────────────────────────
// Desde el mantenimiento del SENA (11-13 jul 2026) el WAF del portal
// (Fortinet — "Web Page Blocked!", Attack ID 20000051) bloquea cualquier
// request cuyo User-Agent contenga "HeadlessChrome", que es lo que manda el
// Chromium headless de Playwright. El MISMO Chromium con UA de Chrome normal
// pasa sin problema (verificado con scripts/probe-waf-ua.js, 21-jul-2026).
// Se construye con el major real del browser (formato UA-reduction de Chrome:
// solo el major, resto en ceros) para no desincronizar versiones.
function uaCamuflado(browser) {
  const major = (browser.version() || "").split(".")[0] || "126";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browserPromise = null;

// Singleton con auto-relanzamiento: si el browser murio (crash/disconnect) se
// vuelve a lanzar transparente en el siguiente getBrowser(). Llamadas
// concurrentes mientras lanza comparten la misma promesa (no doble launch).
async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.isConnected()) return browser;
    } catch (_) {
      // la promesa anterior fallo al lanzar; caemos a relanzar
    }
    browserPromise = null;
  }

  const p = chromium.launch({ headless: true, args: LAUNCH_ARGS });
  browserPromise = p;

  let browser;
  try {
    browser = await p;
  } catch (err) {
    if (browserPromise === p) browserPromise = null;
    throw err;
  }

  browser.on("disconnected", () => {
    if (browserPromise === p) browserPromise = null;
  });

  return browser;
}

// Abre un context nuevo sobre el browser compartido. Acepta las mismas opciones
// que browser.newContext() (locale, timezoneId, storageState, ...).
async function acquireContext(opts = {}) {
  // Espera a que haya cupo en el semaforo antes de abrir el context.
  let waited = false;
  while (activeContexts >= MAX_CONTEXTS) {
    if (!waited) { waited = true; console.log(`[browserPool] cap alcanzado (${MAX_CONTEXTS}), encolando context...`); }
    await sleep(500);
  }
  activeContexts++;

  let context = null;
  try {
    const browser = await getBrowser();
    // userAgent camuflado por defecto (anti-WAF, ver uaCamuflado); el caller
    // puede pisarlo pasando su propio opts.userAgent.
    context = await browser.newContext({ userAgent: uaCamuflado(browser), ...opts });

    if (BLOCK_RESOURCES) {
      await context.route("**/*", (route) => {
        if (BLOCKED_TYPES.has(route.request().resourceType())) return route.abort();
        return route.continue();
      });
    }

    return context;
  } catch (err) {
    // Fallo al preparar el context: cerrarlo si alcanzo a crearse y liberar el
    // cupo reservado del semaforo.
    if (context) { try { await context.close(); } catch (_) {} }
    activeContexts = Math.max(0, activeContexts - 1);
    throw err;
  }
}

// Cierra SOLO el context (no el browser compartido) y libera el cupo del
// semaforo. Idempotente/silencioso.
async function releaseContext(context) {
  if (!context) return;
  try { await context.close(); } catch (_) { /* ya cerrado */ }
  activeContexts = Math.max(0, activeContexts - 1);
}

module.exports = { getBrowser, acquireContext, releaseContext };
