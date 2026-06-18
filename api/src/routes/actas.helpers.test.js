// Tests de los helpers puros del módulo de Actas — `node --test`.
// Sin dependencias externas: usa node:test + node:assert nativos.
// Sin Prisma, sin Redis, sin Postgres — los helpers son funciones puras.
//
//   node --test api/src/routes/actas.helpers.test.js
//   (o `npm test` desde la raíz)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  construirMapaRapEvidencias,
  detectarRapsSinEvidencias,
  inyectarVirtualesSinEntregar,
} = require("./actas.helpers");

// También importamos calcularEstado para el caso integrado (no requiere DB).
const { calcularEstado } = require("../lib/calificacion");

// ─── construirMapaRapEvidencias ───────────────────────────────────────────────

test("construirMapaRapEvidencias: agrupa correctamente por rapId", () => {
  const confirmadas = [
    { rapId: "rap1", evidenciaId: "ev1" },
    { rapId: "rap1", evidenciaId: "ev2" },
    { rapId: "rap2", evidenciaId: "ev3" },
  ];
  const ia = [];

  const { mapaRapEvidencias, todasEvidenciaIds } = construirMapaRapEvidencias(confirmadas, ia);

  assert.equal(mapaRapEvidencias.size, 2);
  assert.deepEqual([...mapaRapEvidencias.get("rap1")].sort(), ["ev1", "ev2"]);
  assert.deepEqual([...mapaRapEvidencias.get("rap2")], ["ev3"]);
  // todasEvidenciaIds debe tener los 3 sin duplicados
  assert.equal(todasEvidenciaIds.length, 3);
});

test("construirMapaRapEvidencias: MatchingPropuesta aceptada agrega al mapa", () => {
  const confirmadas = [
    { rapId: "rap1", evidenciaId: "ev1" },
  ];
  const ia = [
    { rapId: "rap1", evidenciaId: "ev2" }, // aceptada → debe entrar
    { rapId: "rap2", evidenciaId: "ev3" }, // nuevo RAP via IA
  ];

  const { mapaRapEvidencias } = construirMapaRapEvidencias(confirmadas, ia);

  assert.equal(mapaRapEvidencias.size, 2);
  assert.deepEqual([...mapaRapEvidencias.get("rap1")].sort(), ["ev1", "ev2"]);
  assert.deepEqual([...mapaRapEvidencias.get("rap2")], ["ev3"]);
});

test("construirMapaRapEvidencias: MatchingPropuesta rechazada NO agrega (no llega al helper)", () => {
  // El filtrado de estado="aceptado" lo hace la query en la ruta ANTES de llamar
  // al helper. El helper recibe solo lo que ya pasó el filtro. Este test verifica
  // que evidencias de IA rechazadas (pasadas por error) SÍ se agregan — lo que
  // confirma que el FILTRO debe estar en la query, no aquí.
  // En producción: la ruta filtra estado:"aceptado" antes de pasarle a este helper.
  const confirmadas = [];
  const rechazadas = [
    { rapId: "rap1", evidenciaId: "ev99" }, // simulamos que llegó sin filtrar
  ];

  const { mapaRapEvidencias } = construirMapaRapEvidencias(confirmadas, rechazadas);
  // El helper las agrega; la responsabilidad del filtro es del caller (la ruta)
  assert.equal(mapaRapEvidencias.get("rap1").has("ev99"), true);
});

test("construirMapaRapEvidencias: deduplica evidenciaIds en todasEvidenciaIds", () => {
  // Misma evidencia en confirmadas y en IA (puede ocurrir si se vinculó 2 veces)
  const confirmadas = [{ rapId: "rap1", evidenciaId: "ev1" }];
  const ia          = [{ rapId: "rap1", evidenciaId: "ev1" }]; // mismo ev1

  const { todasEvidenciaIds } = construirMapaRapEvidencias(confirmadas, ia);
  assert.equal(todasEvidenciaIds.length, 1);
});

test("construirMapaRapEvidencias: tablas vacías → mapa vacío + array vacío", () => {
  const { mapaRapEvidencias, todasEvidenciaIds } = construirMapaRapEvidencias([], []);
  assert.equal(mapaRapEvidencias.size, 0);
  assert.equal(todasEvidenciaIds.length, 0);
});

// ─── detectarRapsSinEvidencias ────────────────────────────────────────────────

test("detectarRapsSinEvidencias: RAP sin vínculo en el mapa → entra en el resultado", () => {
  const rapIds = ["rap1", "rap2", "rap3"];
  // Solo rap1 y rap2 tienen evidencias
  const mapa = new Map([
    ["rap1", new Set(["ev1"])],
    ["rap2", new Set(["ev2"])],
    // rap3 no está → debe detectarse
  ]);
  const codigos = new Map([
    ["rap1", "220501010-RA01"],
    ["rap2", "220501010-RA02"],
    ["rap3", "220501010-RA03"],
  ]);

  const sinEvidencias = detectarRapsSinEvidencias(rapIds, mapa, codigos);

  assert.equal(sinEvidencias.length, 1);
  assert.equal(sinEvidencias[0].id, "rap3");
  assert.equal(sinEvidencias[0].codigo, "220501010-RA03");
});

test("detectarRapsSinEvidencias: todos con vínculos → array vacío (no hay 422)", () => {
  const rapIds = ["rap1", "rap2"];
  const mapa = new Map([
    ["rap1", new Set(["ev1"])],
    ["rap2", new Set(["ev2", "ev3"])],
  ]);
  const codigos = new Map([["rap1", "RA01"], ["rap2", "RA02"]]);

  const sinEvidencias = detectarRapsSinEvidencias(rapIds, mapa, codigos);

  assert.equal(sinEvidencias.length, 0);
});

test("detectarRapsSinEvidencias: tablas vacías → TODOS los RAPs sin evidencias (caso del 422 universal)", () => {
  // Este es el caso del bloqueador histórico: RapEvidenciaRel=0 →
  // mapaRapEvidencias vacío → todos los RAPs del acta fallan la validación.
  const rapIds = ["rap1", "rap2", "rap3"];
  const mapaVacio = new Map();
  const codigos = new Map([
    ["rap1", "RA01"], ["rap2", "RA02"], ["rap3", "RA03"],
  ]);

  const sinEvidencias = detectarRapsSinEvidencias(rapIds, mapaVacio, codigos);

  assert.equal(sinEvidencias.length, 3);
  // Usando rapId como fallback de codigo cuando no está en el map
  const ids = sinEvidencias.map(r => r.id);
  assert.deepEqual(ids.sort(), ["rap1", "rap2", "rap3"]);
});

test("detectarRapsSinEvidencias: RAP en mapa pero con Set vacío también falla", () => {
  // Set<> vacío cuenta como sin evidencias — no es un vínculo real
  const rapIds = ["rap1"];
  const mapa = new Map([["rap1", new Set()]]);
  const codigos = new Map([["rap1", "RA01"]]);

  const sinEvidencias = detectarRapsSinEvidencias(rapIds, mapa, codigos);
  assert.equal(sinEvidencias.length, 1);
});

// ─── inyectarVirtualesSinEntregar ─────────────────────────────────────────────

test("inyectarVirtualesSinEntregar: evidencia con entrega real → pasa tal cual", () => {
  const evidIds = new Set(["ev1"]);
  const entregaReal = { evidenciaId: "ev1", estado: "calificado", notaActual: 85, notaCualitativa: null };
  const entregasMap = new Map([["ev1", entregaReal]]);

  const resultado = inyectarVirtualesSinEntregar(evidIds, entregasMap);

  assert.equal(resultado.length, 1);
  assert.equal(resultado[0], entregaReal); // misma referencia
});

test("inyectarVirtualesSinEntregar: evidencia sin entrega → virtual sin_entregar", () => {
  const evidIds = new Set(["ev1"]);
  const entregasMap = new Map(); // aprendiz no entregó nada

  const resultado = inyectarVirtualesSinEntregar(evidIds, entregasMap);

  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].estado, "sin_entregar");
  assert.equal(resultado[0].notaActual, null);
  assert.equal(resultado[0].evidenciaId, "ev1");
});

test("inyectarVirtualesSinEntregar: mezcla — 1 real + 2 virtuales → RAP NO aprobado", () => {
  // El aprendiz aprobó ev1 (nota 80) pero nunca entregó ev2 y ev3.
  // Con calcularEstado(every), el RAP debe quedar NO aprobado.
  const evidIds = new Set(["ev1", "ev2", "ev3"]);
  const entregasMap = new Map([
    ["ev1", { evidenciaId: "ev1", estado: "calificado", notaActual: 80, notaCualitativa: null }],
    // ev2 y ev3 no están en el mapa → se inyectan virtuales
  ]);

  const entregas = inyectarVirtualesSinEntregar(evidIds, entregasMap);

  assert.equal(entregas.length, 3);

  // Ahora calcularEstado (importado de lib/calificacion) debe retornar NO aprobó
  // porque dos evidencias son sin_entregar.
  const resultado = calcularEstado(entregas);
  assert.notEqual(resultado.estado, "APROBÓ",
    "Con 2 evidencias sin entregar, el RAP NO puede quedar APROBÓ");
});
