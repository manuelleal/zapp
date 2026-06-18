/**
 * api/src/lib/playwrightSession.js
 *
 * Factory ÚNICA de sesión Playwright autenticada en Zajuna (plan 003).
 * Reemplaza el bloque de ~25 líneas que repetían 11 workers (cargar sesión de
 * Redis → acquireContext → validar → login fresco si expiró → guardar sesión),
 * que además había divergido entre workers (distinto chequeo de sesión válida,
 * distintos timeouts, solo algunos con UnrecoverableError).
 *
 * Suma la pieza CLAVE del post-mortem (P0.1): un CANDADO POR-USUARIO. Como
 * Zajuna admite una sola sesión por cuenta, dos jobs del mismo userId a la vez
 * se pisan la sesión. La factory adquiere el candado ANTES de tocar la sesión y
 * lo libera en release(); así el trabajo de un usuario se serializa entre TODAS
 * las colas, sin corrupción silenciosa.
 *
 * Uso en un worker:
 *   const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc });
 *   try {
 *     // ... usar sesion.page / sesion.ctx ...
 *     // si Moodle expulsa a mitad de job: await sesion.relogin();
 *   } finally {
 *     await sesion.release();   // libera context Y candado (idempotente)
 *   }
 *
 * El caller SIEMPRE debe llamar release() en su finally (antes se llamaba
 * releaseContext(ctx); ahora release() hace eso Y suelta el candado).
 */
const { UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("./browserPool");
const { saveSession, loadSession } = require("./sessionStore");
const { decrypt } = require("./crypto");
const { acquireUserLock } = require("./userLock");
const { esSesionValidaUrl } = require("./esSesionValida");
const { marcarCredencialesInvalidas, marcarCredencialesValidas } = require("./credencialesEstado");
const { login, cerrarModal, BASE_URL, TIMEOUT, log } = require("../../../scraper/auth");

/**
 * crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts })
 *   → { ctx, page, relogin, release }
 *
 * opts:
 *   timeout                 (default TIMEOUT de auth.js)   → page.setDefaultTimeout
 *   credencialesMalasEsFatal (default true)                → "Credenciales incorrectas." → UnrecoverableError
 *   lockTimeoutMs           (default el de userLock)        → cuánto esperar el candado
 */
async function crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts = {} }) {
  const timeout = opts.timeout ?? TIMEOUT;
  const credencialesMalasEsFatal = opts.credencialesMalasEsFatal ?? true;
  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  // 1) Candado por-usuario ANTES de tocar la sesión (Zajuna = 1 sesión/cuenta).
  const releaseLock = await acquireUserLock(userId, { timeoutMs: opts.lockTimeoutMs });

  let ctx;
  try {
    const savedSession = await loadSession(userId);
    ctx = await acquireContext({
      locale: "es-CO",
      timezoneId: "America/Bogota",
      ...(savedSession ? { storageState: savedSession } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeout);

    // Reúsa la sesión guardada si sigue viva; si no (o si forzar=true), login fresco.
    async function entrar(forzar) {
      let sessionValida = false;
      if (!forzar && savedSession) {
        await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout });
        await cerrarModal(page);
        sessionValida = esSesionValidaUrl(page.url());
        if (!sessionValida) log("[playwrightSession] sesión expirada, login fresco");
      }
      if (!sessionValida) {
        try {
          await login(page, zajunaUser, zajunaPass);
          await marcarCredencialesValidas(userId);
        } catch (err) {
          if (err.message === "Credenciales incorrectas." && credencialesMalasEsFatal) {
            await marcarCredencialesInvalidas(userId);
            throw new UnrecoverableError(err.message);
          }
          throw err;
        }
        await saveSession(userId, await ctx.storageState())
          .catch((e) => log(`[playwrightSession] no se pudo guardar sesión: ${e.message}`));
      }
    }

    await entrar(false);

    // relogin(): descarta la sesión actual y vuelve a loguear, conservando el
    // mismo ctx/page y el candado (para reconexión a mitad de job).
    async function relogin() {
      await entrar(true);
    }

    let ctxLiberado = false;
    let lockLiberado = false;
    // Libera SOLO el browser (context), manteniendo el candado. Para jobs que
    // tras el login hacen el trabajo pesado por fetch (sin Chromium) pero deben
    // seguir siendo dueños únicos de la sesión (ej. leerConfigLoteWorker).
    async function releaseBrowser() {
      if (ctxLiberado) return;
      ctxLiberado = true;
      await releaseContext(ctx);
    }
    // Libera todo (browser + candado). Idempotente. SIEMPRE en el finally.
    async function release() {
      await releaseBrowser();
      if (lockLiberado) return;
      lockLiberado = true;
      await releaseLock();
    }

    return { ctx, page, relogin, release, releaseBrowser };
  } catch (err) {
    // Falló antes de devolver: soltar context (si se creó) y el candado SIEMPRE.
    if (ctx) await releaseContext(ctx).catch(() => {});
    await releaseLock().catch(() => {});
    throw err;
  }
}

module.exports = { crearSesionAutenticada, esSesionValidaUrl };
