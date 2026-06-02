import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formatea un instante en texto relativo al momento actual.
 *
 * Acepta dos formas:
 *   - `number`       → epoch ms (uso original, ej. desde Dashboard scan-progress)
 *   - `string | null` → fecha ISO / timestamp string (ej. desde EvidenciasConfig / Dashboard)
 *
 * El formato de salida varía levemente entre ambas formas para conservar
 * el comportamiento original de cada call-site:
 *   - number  → "hace N s/min/h/d" (minúsculas, sin acento)
 *   - string  → "Hace un momento / Hace N min / Hace Nh / Hace Nd / Nunca"
 *
 * Si necesitas unificar el formato en el futuro, hazlo aquí sin tocar los
 * call-sites.
 */
export function tiempoRelativo(fecha: number): string
export function tiempoRelativo(fecha: string | null): string
export function tiempoRelativo(fecha: number | string | null): string {
  if (fecha === null || fecha === undefined) return "Nunca"

  const ms = typeof fecha === "number" ? fecha : new Date(fecha).getTime()

  if (typeof fecha === "number") {
    // Formato original: "hace N s/min/h/d"
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
    if (diffSec < 60) return `hace ${diffSec} s`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `hace ${diffMin} min`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `hace ${diffH} h`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 30) return `hace ${diffD} d`
    return `el ${new Date(ms).toLocaleDateString("es-CO")}`
  }

  // Formato de las páginas: "Hace un momento / Hace N min / ..."
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Hace un momento"
  if (mins < 60) return `Hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `Hace ${hrs}h`
  return `Hace ${Math.floor(hrs / 24)}d`
}

/**
 * Extrae el número de guía de aprendizaje (GA) del nombre de una evidencia.
 * Devuelve 999 cuando no se encuentra (para ordenar al final).
 *
 * Ejemplo: "GA3 - Tarea de inglés" → 3
 */
export function gaNum(nombre: string): number {
  const m = nombre.match(/GA(\d+)/i)
  return m ? parseInt(m[1]) : 999
}
