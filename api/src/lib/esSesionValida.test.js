const { test } = require("node:test");
const assert = require("node:assert/strict");
const { esSesionValidaUrl } = require("./esSesionValida");

test("esSesionValidaUrl: /my/ autenticado → válida", () => {
  assert.equal(esSesionValidaUrl("https://zajuna.sena.edu.co/zajuna/my/"), true);
});

test("esSesionValidaUrl: portal raíz (sesión expirada de SENA) → NO válida", () => {
  // SENA rebota al portal raíz, no a /login: aquí estaba el falso positivo.
  assert.equal(esSesionValidaUrl("https://zajuna.sena.edu.co/"), false);
});

test("esSesionValidaUrl: página de login → NO válida", () => {
  assert.equal(esSesionValidaUrl("https://zajuna.sena.edu.co/zajuna/login/index.php"), false);
});

test("esSesionValidaUrl: url vacía/undefined → NO válida", () => {
  assert.equal(esSesionValidaUrl(""), false);
  assert.equal(esSesionValidaUrl(undefined), false);
});
