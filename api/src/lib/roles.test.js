/**
 * roles.test.js — Pruebas del criterio ÚNICO de superadmin (lib/roles.js).
 *
 * Corre con: node --test  (desde la raíz, igual que calificacion.test.js).
 *
 * Cubre el blindaje del panel /admin y del simulador: el dueño (SUPERADMIN_EMAIL)
 * siempre cuenta como superadmin aunque su `rol` en DB sea "instructor" (caso real:
 * la DB de prod se recreó con el default y el dueño quedó bloqueado).
 */
const { test } = require("node:test");
const assert = require("node:assert");

// El helper lee SUPERADMIN_EMAIL al cargar el módulo → fijarlo ANTES del require.
process.env.SUPERADMIN_EMAIL = "dueno@ejemplo.com";
const { esSuperadmin, esEmailSuperadmin } = require("./roles");

test("rol superadmin siempre cuenta, sin importar el email", () => {
  assert.strictEqual(esSuperadmin({ rol: "superadmin", email: "x@y.com" }), true);
});

test("el correo del dueño es superadmin aunque su rol sea instructor", () => {
  assert.strictEqual(esSuperadmin({ rol: "instructor", email: "dueno@ejemplo.com" }), true);
});

test("la comparación de email tolera mayúsculas y espacios", () => {
  assert.strictEqual(esSuperadmin({ rol: "instructor", email: "  DUENO@Ejemplo.com " }), true);
});

test("instructor con otro correo NO es superadmin", () => {
  assert.strictEqual(esSuperadmin({ rol: "instructor", email: "otro@y.com" }), false);
});

test("usuario nulo o vacío NO es superadmin", () => {
  assert.strictEqual(esSuperadmin(null), false);
  assert.strictEqual(esSuperadmin({}), false);
});

test("esEmailSuperadmin compara contra SUPERADMIN_EMAIL", () => {
  assert.strictEqual(esEmailSuperadmin("dueno@ejemplo.com"), true);
  assert.strictEqual(esEmailSuperadmin("nadie@y.com"), false);
  assert.strictEqual(esEmailSuperadmin(null), false);
});
