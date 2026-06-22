/**
 * roles.js — Decisión ÚNICA de "quién es superadmin".
 *
 * POR QUÉ: había DOS criterios distintos en el código — `admin.js` miraba el campo
 * `rol` de la DB y `ajustes.js` miraba `email === SUPERADMIN_EMAIL`. Si la DB de prod
 * se recreaba, el `rol` volvía a su default ("instructor") y el dueño quedaba FUERA
 * del panel /admin pero DENTRO del simulador — inconsistente y frágil. Este helper
 * unifica ambos criterios para que:
 *   1. el dueño (definido por env) SIEMPRE sea superadmin, inmune a resets de DB, y
 *   2. todos los módulos decidan exactamente igual.
 *
 * Un usuario es superadmin si su `rol` es "superadmin" O su email coincide con
 * SUPERADMIN_EMAIL (operador-controlado vía .env). La comparación de email es
 * case-insensitive y tolerante a espacios. Sin SUPERADMIN_EMAIL no hay fallback
 * por email (nadie es superadmin salvo quien tenga rol="superadmin" en DB).
 */

const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase() || null;

// ¿Este email es el del dueño de la app (SUPERADMIN_EMAIL)?
function esEmailSuperadmin(email) {
  if (!SUPERADMIN_EMAIL || !email) return false;
  return String(email).trim().toLowerCase() === SUPERADMIN_EMAIL;
}

// `user` puede venir del JWT (req.user: { email, rol, ... }) o de la DB.
function esSuperadmin(user) {
  if (!user) return false;
  if (user.rol === "superadmin") return true;
  return esEmailSuperadmin(user.email);
}

module.exports = { esSuperadmin, esEmailSuperadmin, SUPERADMIN_EMAIL };
