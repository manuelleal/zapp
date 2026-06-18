/**
 * credencialesEstado.js — marca/limpia el flag de "credenciales de Zajuna inválidas".
 *
 * POR QUÉ: en el SENA, Sofía (admin) obliga a cambiar la contraseña de Zajuna con
 * frecuencia. Cuando el instructor la cambia en Zajuna, la app sigue usando la clave
 * vieja cifrada en DB → el login del worker falla con "Credenciales incorrectas."
 * (scraper/auth.js). Antes eso solo quedaba en Job.errorMsg y el instructor no se
 * enteraba. Con este flag (`User.zajunaCredsInvalidasAt`) la UI muestra un aviso
 * global "Actualiza tu contraseña de Zajuna".
 *
 * Lo usan los 9 workers que hacen login (ver patrón en fichasWorker.js) y la ruta
 * POST /api/ajustes/zajuna (al guardar la clave nueva limpia el flag).
 *
 * Ambas funciones usan `updateMany` con condición sobre el estado actual para NO
 * escribir en cada job: solo tocan la fila cuando el flag realmente cambia. Nunca
 * lanzan: un fallo aquí no debe tumbar el flujo del worker.
 */

const prisma = require("../db/client");

/** Marca las credenciales como inválidas (si no lo estaban ya). */
async function marcarCredencialesInvalidas(userId) {
  if (!userId) return;
  try {
    await prisma.user.updateMany({
      where: { id: userId, zajunaCredsInvalidasAt: null },
      data:  { zajunaCredsInvalidasAt: new Date() },
    });
  } catch (e) {
    console.error(`[credencialesEstado] no se pudo marcar inválidas (${userId}): ${e.message}`);
  }
}

/** Limpia el flag (si estaba marcado): el login volvió a funcionar. */
async function marcarCredencialesValidas(userId) {
  if (!userId) return;
  try {
    await prisma.user.updateMany({
      where: { id: userId, NOT: { zajunaCredsInvalidasAt: null } },
      data:  { zajunaCredsInvalidasAt: null },
    });
  } catch (e) {
    console.error(`[credencialesEstado] no se pudo limpiar flag (${userId}): ${e.message}`);
  }
}

module.exports = { marcarCredencialesInvalidas, marcarCredencialesValidas };
