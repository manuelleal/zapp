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
  const browser = await getBrowser();
  return browser.newContext(opts);
}

// Cierra SOLO el context (no el browser compartido). Idempotente/silencioso.
async function releaseContext(context) {
  if (!context) return;
  try { await context.close(); } catch (_) { /* ya cerrado */ }
}

module.exports = { getBrowser, acquireContext, releaseContext };
