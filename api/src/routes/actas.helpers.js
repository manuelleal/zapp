/**
 * api/src/routes/actas.helpers.js — Funciones puras del módulo de Actas.
 *
 * QUÉ HACE: contiene la lógica pura (sin Prisma, sin reply) que se comparte
 * entre los dos endpoints de generación de actas:
 *   - POST /api/actas/:id/auto-poblar
 *   - POST /api/actas/preview-native
 *
 * Extraído de actas.js para poder testearlas en aislamiento y evitar
 * duplicación de código (ambos endpoints tenían exactamente el mismo bloque
 * para armar el mapa RAP→evidencias y para detectar RAPs sin vínculos).
 *
 * REGLAS SENA aplicables (ver CLAUDE.md §5):
 *   - El mapa RAP→evidencias se arma SOLO desde `RapEvidenciaRel` (vínculos
 *     confirmados) y `MatchingPropuesta` con estado "aceptado". Sin esos datos,
 *     NO hay modo fallback — los endpoints devuelven 422 RAP_SIN_EVIDENCIAS.
 *   - Una evidencia sin entrega de un aprendiz se inyecta como virtual
 *     `sin_entregar` para que `calcularEstado` cubra TODAS las evidencias
 *     del RAP (no solo las que existen). Esto garantiza que `every` refleje
 *     correctamente la realidad.
 *
 * NO TOCAR sin entender el efecto en auto-poblar y preview-native.
 */

// ─── construirMapaRapEvidencias ───────────────────────────────────────────────
//
// Combina filas de RapEvidenciaRel (vínculos confirmados) y MatchingPropuesta
// aceptadas en un Map: rapId → Set<evidenciaId>. También devuelve el array
// plano dedupado de todos los evidenciaIds (usado para la query de entregas).
//
// Parámetros:
//   relsConfirmadas: Array<{ rapId: string, evidenciaId: string }>
//   relsIA:          Array<{ rapId: string, evidenciaId: string }>
//
// Retorna:
//   { mapaRapEvidencias: Map<string, Set<string>>, todasEvidenciaIds: string[] }
//
function construirMapaRapEvidencias(relsConfirmadas, relsIA) {
  const mapaRapEvidencias = new Map();
  for (const rel of [...relsConfirmadas, ...relsIA]) {
    if (!mapaRapEvidencias.has(rel.rapId)) mapaRapEvidencias.set(rel.rapId, new Set());
    mapaRapEvidencias.get(rel.rapId).add(rel.evidenciaId);
  }
  const todasEvidenciaIds = [...new Set([...relsConfirmadas, ...relsIA].map(r => r.evidenciaId))];
  return { mapaRapEvidencias, todasEvidenciaIds };
}

// ─── detectarRapsSinEvidencias ────────────────────────────────────────────────
//
// Detecta qué RAPs del acta NO tienen evidencias vinculadas. Si alguno falta,
// el endpoint debe devolver 422 RAP_SIN_EVIDENCIAS (ver actas.js, endpoints
// auto-poblar y preview-native). Esta verificación es el "Mapeo al Vuelo" —
// evita el fallback silencioso que antes dejaba a todos en PENDIENTE.
//
// Parámetros:
//   rapIds:            string[]                      — IDs de los RAPs del acta
//   mapaRapEvidencias: Map<string, Set<string>>       — resultado de construirMapaRapEvidencias
//   rapCodigoPorId:    Map<string, string>            — rapId → codigo (para el mensaje de error)
//
// Retorna:
//   Array<{ id: string, codigo: string }>  — vacío si todos tienen vínculos
//
function detectarRapsSinEvidencias(rapIds, mapaRapEvidencias, rapCodigoPorId) {
  const rapsSinEvidencias = [];
  for (const rapId of rapIds) {
    const evidenciasDelRap = mapaRapEvidencias.get(rapId);
    if (!evidenciasDelRap || evidenciasDelRap.size === 0) {
      rapsSinEvidencias.push({
        id: rapId,
        codigo: rapCodigoPorId.get(rapId) || rapId
      });
    }
  }
  return rapsSinEvidencias;
}

// ─── inyectarVirtualesSinEntregar ─────────────────────────────────────────────
//
// Para un RAP dado, devuelve el array de entregas que `calcularEstado` debe
// evaluar. Si el aprendiz no tiene entrega para alguna evidencia del RAP,
// inyecta un objeto virtual { evidenciaId, estado: "sin_entregar", notaActual: null }
// para que el cálculo cubra TODAS las evidencias (no solo las existentes).
//
// Esto es esencial porque `calcularEstado` usa `every(esAprobada)` —  si
// faltara una evidencia, el RAP quedaría erróneamente como "aprobado" con
// solo las entregas que existen.
//
// Parámetros:
//   evidIds:    Set<string> | Iterable<string>  — evidenciaIds del RAP
//   entregasMap: Map<string, object>             — evidenciaId → entrega del aprendiz
//
// Retorna:
//   Array de entregas (reales + virtuales)
//
function inyectarVirtualesSinEntregar(evidIds, entregasMap) {
  return [...evidIds].map(eid =>
    entregasMap.get(eid) ?? { evidenciaId: eid, estado: "sin_entregar", notaActual: null }
  );
}

module.exports = {
  construirMapaRapEvidencias,
  detectarRapsSinEvidencias,
  inyectarVirtualesSinEntregar,
};
