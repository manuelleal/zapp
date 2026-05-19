/**
 * Heurísticas para identificar nombres "sucios" / de sistema en la lista de
 * aprendices que viene del scraper de Zajuna.
 *
 * Casos reales observados:
 *  - "AA", "AG", "AB"            → siglas / códigos de sistema
 *  - "ABALEJANDRO"               → 2 mayúsculas pegadas + nombre real, sin espacio
 *  - ""                          → vacío
 *  - "JUAN PEREZ", "MARÍA JOSÉ"  → válidos
 *
 * Regla central: un nombre real de persona casi siempre tiene al menos un
 * espacio (nombre + apellido) y suele tener ≥ 5 caracteres significativos.
 *
 * Mantenemos un patrón estricto y conservador para no descartar nombres
 * legítimos por error.
 */

// Patrón legacy (≤4 chars o 1-3 mayúsculas sueltas). Se mantiene exportado por
// retrocompatibilidad con el código que aún hace `regex.test(nombre)`.
const NOMBRE_INVALIDO = /^[A-Z]{1,3}$|^.{1,4}$/;

/**
 * @param {string|null|undefined} nombreRaw
 * @returns {boolean} true si el nombre parece válido (de persona real).
 */
function esNombreValido(nombreRaw) {
  if (!nombreRaw) return false;
  const nombre = String(nombreRaw).trim();

  // 1. Vacío o muy corto → inválido
  if (nombre.length <= 4) return false;

  // 2. Patrón legacy: 1-3 mayúsculas sueltas ("AA", "AG", "ABC") → inválido
  if (/^[A-Z]{1,3}$/.test(nombre)) return false;

  // 3. Sin espacios + > 6 chars → sospechoso, requiere análisis adicional
  if (!/\s/.test(nombre) && nombre.length > 6) {
    // 3a. "ABALEJANDRO" → empieza con 2+ mayúsculas seguidas pegadas a más letras.
    //     Si después de las primeras 2-3 mayúsculas sigue una cadena con
    //     mayúscula(s) más minúscula(s) o más mayúsculas, es probablemente
    //     un código + nombre concatenado.
    if (/^[A-Z]{2,3}[A-Z]/.test(nombre)) return false;

    // 3b. Todo mayúsculas pegado, sin espacio, > 8 chars → sospechoso pero
    //     ambiguo (puede ser apellido compuesto). Ser conservadores: aceptar.
  }

  return true;
}

/**
 * Filtra una lista de aprendices retornando solo aquellos con nombre válido.
 * @template T
 * @param {Array<T & { nombre: string|null }>} aprendices
 * @returns {Array<T>}
 */
function filtrarAprendicesValidos(aprendices) {
  return aprendices.filter(a => esNombreValido(a?.nombre));
}

module.exports = { NOMBRE_INVALIDO, esNombreValido, filtrarAprendicesValidos };
