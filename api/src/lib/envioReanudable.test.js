// Tests de envioReanudable — `node --test`.
// Sin dependencias externas: usa node:test + node:assert nativos.
// Cubre la lógica de filtrado de destinatarios para reanudación de envíos
// masivos en retries de BullMQ (idempotencia del mensajeFormativoWorker).
//
//   node --test api/src/lib/envioReanudable.test.js
//   (o `npm test` desde la raíz)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { destinatariosPendientes } = require("./envioReanudable");

// ─── destinatariosPendientes ──────────────────────────────────────────────────

test("destinatariosPendientes: progreso vacío → devuelve todos", () => {
  const dests = [
    { moodleId: 1001, nombre: "Ana" },
    { moodleId: 1002, nombre: "Carlos" },
    { moodleId: 1003, nombre: "María" },
  ];
  const resultado = destinatariosPendientes(dests, []);
  assert.equal(resultado.length, 3);
  assert.deepEqual(resultado, dests);
});

test("destinatariosPendientes: 2 de 5 ya enviados → devuelve los 3 restantes", () => {
  const dests = [
    { moodleId: 1001, nombre: "Ana" },
    { moodleId: 1002, nombre: "Carlos" },
    { moodleId: 1003, nombre: "María" },
    { moodleId: 1004, nombre: "Pedro" },
    { moodleId: 1005, nombre: "Luisa" },
  ];
  const resultado = destinatariosPendientes(dests, [1001, 1003]);
  assert.equal(resultado.length, 3);
  const ids = resultado.map(d => d.moodleId);
  assert.ok(ids.includes(1002), "debe incluir a Carlos (1002)");
  assert.ok(ids.includes(1004), "debe incluir a Pedro (1004)");
  assert.ok(ids.includes(1005), "debe incluir a Luisa (1005)");
  assert.ok(!ids.includes(1001), "debe excluir a Ana (ya enviada)");
  assert.ok(!ids.includes(1003), "debe excluir a María (ya enviada)");
});

test("destinatariosPendientes: destinatario sin moodleId → siempre incluido", () => {
  const dests = [
    { moodleId: 1001, nombre: "Con ID" },
    { moodleId: null,      nombre: "Sin ID (null)" },
    { nombre: "Sin ID (undefined)" },
  ];
  // 1001 ya enviado, pero los sin ID deben pasar igual
  const resultado = destinatariosPendientes(dests, [1001]);
  assert.equal(resultado.length, 2, "los dos sin moodleId deben estar incluidos");
  const nombres = resultado.map(d => d.nombre);
  assert.ok(nombres.includes("Sin ID (null)"), "sin id null incluido");
  assert.ok(nombres.includes("Sin ID (undefined)"), "sin id undefined incluido");
  assert.ok(!nombres.includes("Con ID"), "Con ID debe excluirse (ya enviado)");
});

test("destinatariosPendientes: moodleId numérico vs string → mismo resultado (normalización)", () => {
  const dests = [
    { moodleId: 1041858, nombre: "Numérico" },
    { moodleId: 1041859, nombre: "Otro" },
  ];
  // Lista de ya enviados con el id como string (ej. vino de JSON.parse de Redis)
  const resultado = destinatariosPendientes(dests, ["1041858"]);
  assert.equal(resultado.length, 1, "solo 1 pendiente (1041859)");
  assert.equal(resultado[0].moodleId, 1041859);
});
