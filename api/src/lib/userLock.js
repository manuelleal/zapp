/**
 * api/src/lib/userLock.js
 *
 * Candado distribuido POR-USUARIO sobre Redis. Zajuna permite UNA sola sesión
 * activa por cuenta: si dos jobs del mismo userId usan la sesión a la vez
 * (aunque sean de colas distintas, ej. escanear + guardar fecha), el segundo
 * login EXPULSA al primero y el primero sigue navegando con sesión muerta →
 * guarda datos basura sin avisar (ver plans/POSTMORTEM_FALLOS.md, P0.1).
 *
 * Este lock serializa TODO el trabajo que toca la sesión Moodle de un usuario:
 * cada worker adquiere el candado antes de loguear/usar la sesión y lo libera
 * al terminar. Mientras uno trabaja, los demás del mismo usuario esperan su turno.
 *
 * Diseño (lock distribuido estándar):
 *   - SET key token NX PX ttl  → solo un dueño a la vez.
 *   - token único (uuid)        → release con check-and-del (Lua): solo el dueño
 *                                 borra SU lock, nunca el de otro.
 *   - renovación (heartbeat)    → para jobs largos (scans de minutos) sin que un
 *                                 worker muerto bloquee al resto más que el TTL.
 */
const crypto = require("crypto");
const { connection } = require("./queue");

const LOCK_TTL_MS = 60_000;            // vida del lock; se renueva mientras se use
const RENEW_EVERY_MS = 20_000;         // heartbeat (< TTL/2 para no perderlo)
const ACQUIRE_TIMEOUT_MS = 5 * 60_000; // cuánto espera un job por su turno
const RETRY_EVERY_MS = 500;

// Solo borra el lock si el token coincide (somos el dueño).
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
// Renueva el TTL solo si seguimos siendo el dueño.
const RENEW_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

function lockKey(userId) {
  return `lock:user:${userId}`;
}

/**
 * Adquiere el candado del usuario (espera su turno hasta timeoutMs). Devuelve
 * una función `release()` idempotente que detiene la renovación y borra el lock.
 */
async function acquireUserLock(userId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const key = lockKey(userId);
  const token = crypto.randomUUID();
  const start = Date.now();

  for (;;) {
    const ok = await connection.set(key, token, "PX", LOCK_TTL_MS, "NX");
    if (ok) break;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        "Otra tarea del mismo usuario está usando la sesión de Zajuna. Reintenta en un momento."
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_EVERY_MS));
  }

  // Heartbeat: renueva el TTL mientras el job trabaja. unref() para no mantener
  // vivo el proceso por este timer.
  const renew = setInterval(() => {
    connection.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS)).catch(() => {});
  }, RENEW_EVERY_MS);
  if (renew.unref) renew.unref();

  let liberado = false;
  return async function release() {
    if (liberado) return;
    liberado = true;
    clearInterval(renew);
    await connection.eval(RELEASE_LUA, 1, key, token).catch(() => {});
  };
}

module.exports = { acquireUserLock, lockKey };
