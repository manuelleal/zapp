// Tests del motor de calificación SENA — `node --test`.
// Sin dependencias externas: usa node:test + node:assert nativos.
//
//   node --test api/src/lib/calificacion.test.js
//   (o `npm test` desde la raíz)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  UMBRAL_SENA,
  esAprobada,
  esPendiente,
  tieneParticipacion,
  calcularEstado,
  calcularJuicio,
} = require("./calificacion");

// ─── esAprobada ──────────────────────────────────────────────────────────────

test("esAprobada: umbral universal = 70", () => {
  assert.equal(UMBRAL_SENA, 70);
});

test("esAprobada: nota >= 70 aprueba", () => {
  assert.equal(esAprobada({ notaActual: 70 }), true);
  assert.equal(esAprobada({ notaActual: 100 }), true);
  assert.equal(esAprobada({ notaActual: 85.5 }), true);
});

test("esAprobada: nota < 70 NO aprueba (incluido 0)", () => {
  assert.equal(esAprobada({ notaActual: 69 }), false);
  assert.equal(esAprobada({ notaActual: 69.99 }), false);
  // Regresión sesión 25-may: nota 0 ya no cuenta como aprobada.
  assert.equal(esAprobada({ notaActual: 0 }), false);
});

test("esAprobada: la nota numérica tiene prioridad sobre el estado", () => {
  // Aunque el estado diga "aprobado", una nota numérica < 70 manda → reprobada.
  assert.equal(esAprobada({ notaActual: 50, estado: "aprobado" }), false);
  // Y nota >= 70 aprueba aunque el estado sea "pendiente".
  assert.equal(esAprobada({ notaActual: 90, estado: "pendiente" }), true);
});

test("esAprobada: sin nota numérica, cualitativa 'A' aprueba", () => {
  assert.equal(esAprobada({ notaActual: null, estado: "A" }), true);
  assert.equal(esAprobada({ notaActual: null, estado: "a" }), true);
});

test("esAprobada: sin nota numérica, estado con 'aprobad' aprueba", () => {
  assert.equal(esAprobada({ notaActual: null, estado: "Aprobado" }), true);
  assert.equal(esAprobada({ notaActual: null, estado: "APROBADA" }), true);
});

test("esAprobada: regresión — 'calificado' sin nota NO aprueba", () => {
  // CLAUDE.md §5.11: calificado sin nota numérica no es evidencia de aprobación.
  assert.equal(esAprobada({ notaActual: null, estado: "calificado" }), false);
});

test("esAprobada: estado vacío/ausente sin nota NO aprueba", () => {
  assert.equal(esAprobada({ notaActual: null, estado: "" }), false);
  assert.equal(esAprobada({ notaActual: null }), false);
  assert.equal(esAprobada({}), false);
});

// ─── esAprobada: cualitativa A/D ─────────────────────────────────────────────
// Casos reales de DB: 60 entregas con notaCualitativa="A" y notaActual=null
// que el motor viejo marcaba erróneamente como NO aprobadas.

test("esAprobada: notaCualitativa A sin nota numérica aprueba", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "calificado", notaCualitativa: "A" }),
    true
  );
});

test("esAprobada: notaCualitativa D sin nota numérica NO aprueba", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "calificado", notaCualitativa: "D" }),
    false
  );
});

test("esAprobada: nota numérica manda sobre cualitativa A (50 < 70 = NO aprueba)", () => {
  assert.equal(
    esAprobada({ notaActual: 50, notaCualitativa: "A" }),
    false
  );
});

test("esAprobada: calificado sin nota numérica ni cualitativa NO aprueba", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "calificado" }),
    false
  );
});

test("esAprobada: regresión regex — 'Desaprobado' NO aprueba (substring viejo lo matcheaba)", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "Desaprobado" }),
    false
  );
});

test("esAprobada: 'No aprobado' NO aprueba", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "No aprobado" }),
    false
  );
});

test("esAprobada: sin_entregar sin cualitativa NO aprueba", () => {
  assert.equal(
    esAprobada({ notaActual: null, estado: "sin_entregar", notaCualitativa: undefined }),
    false
  );
});

// ─── esPendiente / tieneParticipacion ────────────────────────────────────────

test("esPendiente: solo el estado 'pendiente' literal", () => {
  assert.equal(esPendiente({ estado: "pendiente" }), true);
  assert.equal(esPendiente({ estado: "Pendiente" }), true);
  assert.equal(esPendiente({ estado: "calificado" }), false);
  assert.equal(esPendiente({ estado: "" }), false);
});

test("tieneParticipacion: sin_entregar/no_entregado/vacío NO participan", () => {
  assert.equal(tieneParticipacion({ estado: "sin_entregar" }), false);
  assert.equal(tieneParticipacion({ estado: "no_entregado" }), false);
  assert.equal(tieneParticipacion({ estado: "" }), false);
  assert.equal(tieneParticipacion({}), false);
});

test("tieneParticipacion: cualquier otro estado SÍ participa", () => {
  assert.equal(tieneParticipacion({ estado: "pendiente" }), true);
  assert.equal(tieneParticipacion({ estado: "calificado" }), true);
  assert.equal(tieneParticipacion({ estado: "entregado" }), true);
});

// ─── calcularEstado ──────────────────────────────────────────────────────────

test("calcularEstado: sin entregas = NO PARTICIPÓ", () => {
  assert.deepEqual(calcularEstado([]), { estado: "NO PARTICIPÓ", hasUngraded: false });
  assert.deepEqual(calcularEstado(null), { estado: "NO PARTICIPÓ", hasUngraded: false });
  assert.deepEqual(calcularEstado(undefined), { estado: "NO PARTICIPÓ", hasUngraded: false });
});

test("calcularEstado: TODAS aprobadas = APROBÓ", () => {
  const r = calcularEstado([{ notaActual: 80 }, { notaActual: 95 }, { notaActual: null, estado: "A" }]);
  assert.equal(r.estado, "APROBÓ");
  assert.equal(r.hasUngraded, false);
});

test("calcularEstado: regresión 25-may — una aprobada de varias NO basta (every, no some)", () => {
  // Antes: entregas.some(esAprobada) daba APROBÓ con 1 de 3. Ahora debe ser PENDIENTE.
  const r = calcularEstado([
    { notaActual: 90 },               // aprobada
    { notaActual: 40 },               // reprobada
    { estado: "pendiente" },          // sin calificar
  ]);
  assert.equal(r.estado, "PENDIENTE");
  assert.equal(r.hasUngraded, true); // hay una pendiente
});

test("calcularEstado: ninguna participa = NO PARTICIPÓ", () => {
  const r = calcularEstado([
    { estado: "sin_entregar", notaActual: null },
    { estado: "no_entregado", notaActual: null },
  ]);
  assert.equal(r.estado, "NO PARTICIPÓ");
  assert.equal(r.hasUngraded, false);
});

test("calcularEstado: virtual sin_entregar arrastra el RAP a no-aprobado", () => {
  // Modo per-rap: si falta una evidencia del RAP se inyecta sin_entregar.
  // Aunque las demás estén aprobadas, el RAP NO puede dar APROBÓ.
  const r = calcularEstado([
    { notaActual: 100, estado: "calificado" },
    { evidenciaId: "x", estado: "sin_entregar", notaActual: null },
  ]);
  assert.equal(r.estado, "PENDIENTE");
});

test("calcularEstado: reprobada sin pendientes = PENDIENTE sin hasUngraded", () => {
  const r = calcularEstado([
    { notaActual: 90, estado: "calificado" },
    { notaActual: 30, estado: "calificado" },
  ]);
  assert.equal(r.estado, "PENDIENTE");
  assert.equal(r.hasUngraded, false); // ninguna en estado 'pendiente'
});

test("calcularEstado: la participación se decide por ESTADO, no por la nota", () => {
  // Matiz importante del motor: tieneParticipacion() solo mira `estado`. Una
  // entrega con nota pero estado vacío/sin_entregar se considera NO participa.
  // En la práctica toda entrega calificada trae estado "calificado", pero el
  // worker debe garantizarlo: una nota suelta sin estado cae en NO PARTICIPÓ.
  const sinEstado = calcularEstado([{ notaActual: 30 }]); // reprobada, sin estado
  assert.equal(sinEstado.estado, "NO PARTICIPÓ");
  const conEstado = calcularEstado([{ notaActual: 30, estado: "calificado" }]);
  assert.equal(conEstado.estado, "PENDIENTE");
});

// ─── calcularJuicio ──────────────────────────────────────────────────────────

test("calcularJuicio: todos APROBÓ = APROBÓ", () => {
  assert.equal(calcularJuicio(["APROBÓ", "APROBÓ"]), "APROBÓ");
});

test("calcularJuicio: todos NO PARTICIPÓ = NO PARTICIPÓ", () => {
  assert.equal(calcularJuicio(["NO PARTICIPÓ", "NO PARTICIPÓ"]), "NO PARTICIPÓ");
});

test("calcularJuicio: mezcla = PENDIENTE", () => {
  assert.equal(calcularJuicio(["APROBÓ", "NO PARTICIPÓ"]), "PENDIENTE");
  assert.equal(calcularJuicio(["APROBÓ", "PENDIENTE"]), "PENDIENTE");
  assert.equal(calcularJuicio(["APROBÓ", "NO PARTICIPÓ", "PENDIENTE"]), "PENDIENTE");
});

test("calcularJuicio: sin RAPs = PENDIENTE (nunca aprueba por vacío)", () => {
  assert.equal(calcularJuicio([]), "PENDIENTE");
  assert.equal(calcularJuicio(null), "PENDIENTE");
  assert.equal(calcularJuicio(undefined), "PENDIENTE");
});
