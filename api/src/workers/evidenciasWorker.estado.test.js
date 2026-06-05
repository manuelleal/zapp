const { test } = require("node:test");
const assert = require("node:assert");

const { estadoDesdeParticipante } = require("../../../scraper/evidencias");

// Regresión: falso "pendiente" pegado tras calificar (caso VICTOR ALFONSO HENAO
// HINCAPIE, 2 jun 2026). El AJAX mod_assign_list_participants de SENA NO trae
// `grade`/`gradingstatus` (verificado en vivo); la señal autoritativa es
// `requiregrading`. Un alumno calificado y luego REABIERTO viene como
// { submitted:false, requiregrading:false, submissionstatus:"reopened" } y debe
// resolver a "calificado", no a "pendiente".

test("estadoDesdeParticipante: reabierto + requiregrading=false (ya calificado) → calificado", () => {
  assert.equal(
    estadoDesdeParticipante({ submitted: false, requiregrading: false, submissionstatus: "reopened" }),
    "calificado"
  );
});

test("estadoDesdeParticipante: requiregrading=true → pendiente (gana sobre cualquier estado)", () => {
  assert.equal(estadoDesdeParticipante({ submitted: true, requiregrading: true, submissionstatus: "submitted" }), "pendiente");
  assert.equal(estadoDesdeParticipante({ submitted: true, requiregrading: true, submissionstatus: "reopened" }), "pendiente");
});

test("estadoDesdeParticipante: entregó y no requiere calificación → calificado", () => {
  assert.equal(
    estadoDesdeParticipante({ submitted: true, requiregrading: false, submissionstatus: "submitted" }),
    "calificado"
  );
});

test("estadoDesdeParticipante: nunca participó (new/vacío) → sin_entregar", () => {
  assert.equal(estadoDesdeParticipante({ submitted: false, requiregrading: false, submissionstatus: "new" }), "sin_entregar");
  assert.equal(estadoDesdeParticipante({ submitted: false, requiregrading: false, submissionstatus: "" }), "sin_entregar");
});

test("estadoDesdeParticipante: borrador sin enviar → pendiente", () => {
  assert.equal(
    estadoDesdeParticipante({ submitted: false, requiregrading: false, submissionstatus: "draft" }),
    "pendiente"
  );
});
