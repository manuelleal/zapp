import { useEffect, useRef } from "react"
import { authFetch } from "@/api/client"

/**
 * Hook reutilizable para hacer polling a `/api/jobs/:jobId` hasta que el job
 * termine (done/error). Limpia el intervalo al desmontar.
 *
 * Usado por: EvidenciasConfig, ConfigTabla, ConfigEvidenciaDialog, MatchingIaPage.
 */
export function usePollJob() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stop() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  function start(
    jobId: string,
    onDone:      (resultado: unknown) => void,
    onError:     (msg: string) => void,
    onProgress?: (p: number) => void,
  ) {
    stop()
    intervalRef.current = setInterval(async () => {
      try {
        const res  = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        const data = await res.json()
        if (!res.ok) { stop(); onError(data?.errorMsg || `Error ${res.status}`); return }
        if (data.status === "done")        { stop(); onDone(data.resultado) }
        else if (data.status === "error")  { stop(); onError(data.errorMsg || "El job falló.") }
        else onProgress?.(data.progreso || 0)
      } catch (e) {
        stop()
        onError(e instanceof Error ? e.message : "Error de red.")
      }
    }, 3000)
  }

  useEffect(() => () => stop(), [])
  return { start, stop }
}

/**
 * Poll de un job hasta done/error. Función simple (no es hook) para usar
 * dentro de callbacks/promesas (ej. ConfigTabla.saveRow). Cada llamada abre
 * su propio intervalo y lo limpia al terminar.
 */
export function pollJobOnce(
  jobId: string,
  onDone:  () => void,
  onError: (m: string) => void,
) {
  const iv = setInterval(async () => {
    try {
      const res  = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      const data = await res.json()
      if (!res.ok) { clearInterval(iv); onError(data?.errorMsg || `Error ${res.status}`); return }
      if (data.status === "done")       { clearInterval(iv); onDone() }
      else if (data.status === "error") { clearInterval(iv); onError(data.errorMsg || "El job falló.") }
    } catch (e) {
      clearInterval(iv)
      onError(e instanceof Error ? e.message : "Error de red.")
    }
  }, 3000)
}
