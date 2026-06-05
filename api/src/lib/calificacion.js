// ─── Motor de calificación SENA ─────────────────────────────────────────────
//
// Funciones PURAS y sin estado para clasificar entregas/RAPs/aprendices según
// las reglas institucionales SENA (GOR-F-084 V02). Extraídas de actas.js para
// poder testearlas en aislamiento y evitar la duplicación entre los endpoints
// `auto-poblar` y `preview-native`.
//
// Reglas (NO modificar sin discusión — ver CLAUDE.md §5.10/§5.11):
//   - Umbral universal: 70/100. Notas < 70 (incluido 0) = PERDIDA.
//   - Sin nota numérica: solo cualitativa "A" o estado que contenga "aprobad".
//   - "calificado" sin nota numérica NO aprueba (no hay evidencia explícita).

const UMBRAL_SENA = 70;

// ¿La entrega está aprobada?
// Umbral SENA: 70 sobre 100. Notas por debajo (incluido 0) = PERDIDA.
// Sin nota numérica: solo "A" o estado que contenga "aprobad" cuenta como aprobada.
function esAprobada(e) {
  if (e.notaActual !== null && e.notaActual !== undefined) {
    return e.notaActual >= UMBRAL_SENA;
  }
  const est = (e.estado ?? "").toLowerCase();
  return /aprobad/.test(est) || est === "a";
}

function esPendiente(e) {
  return (e.estado ?? "").toLowerCase() === "pendiente";
}

// Intento de participación: cualquier estado que no sea sin_entregar/vacío.
function tieneParticipacion(e) {
  const est = (e.estado ?? "").toLowerCase();
  if (!est || est === "sin_entregar" || est === "no_entregado") return false;
  return true;
}

// REGLAS ESTRICTAS por RAP:
//   APROBÓ       : TODAS las entregas asociadas evaluadas y aprobadas.
//   NO PARTICIPÓ : NINGUNA entrega tiene intento de participación.
//   PENDIENTE    : Cualquier caso intermedio (parcial, sin calificar, reprobado).
function calcularEstado(entregas) {
  if (!entregas || entregas.length === 0) {
    return { estado: "NO PARTICIPÓ", hasUngraded: false };
  }
  const todasAprobadas     = entregas.every(esAprobada);
  const ningunaParticipa   = entregas.every(e => !tieneParticipacion(e));
  const algunaSinCalificar = entregas.some(esPendiente);

  if (todasAprobadas)   return { estado: "APROBÓ",       hasUngraded: false };
  if (ningunaParticipa) return { estado: "NO PARTICIPÓ", hasUngraded: false };
  return                       { estado: "PENDIENTE",    hasUngraded: algunaSinCalificar };
}

// JUICIO GENERAL desde los estados por RAP de un aprendiz — REGLAS ESTRICTAS:
//   APROBÓ       : TODOS los RAPs en "APROBÓ".
//   NO PARTICIPÓ : TODOS los RAPs en "NO PARTICIPÓ".
//   PENDIENTE    : Cualquier otra mezcla (o sin RAPs).
function calcularJuicio(rapStatusValores) {
  const valores = rapStatusValores ?? [];
  if (valores.length > 0 && valores.every(v => v === "APROBÓ"))       return "APROBÓ";
  if (valores.length > 0 && valores.every(v => v === "NO PARTICIPÓ")) return "NO PARTICIPÓ";
  return "PENDIENTE";
}

module.exports = {
  UMBRAL_SENA,
  esAprobada,
  esPendiente,
  tieneParticipacion,
  calcularEstado,
  calcularJuicio,
};
