import { useState, useRef, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { apiFetch, authFetch, ApiError } from "@/api/client"
import { tiempoRelativo } from "@/lib/utils"
import AprendicesPanel from "@/components/AprendicesPanel"

interface Evidencia {
  id: string
  nombre: string
  href: string | null
  tipo: string | null
  cerradaAt: string | null
  pendientes: number
  calificados: number
  sinEntregar: number
  total: number
  ultimoScan: string | null
}

interface EvidenciasResponse {
  evidencias: Evidencia[]
  cerradasCount: number
}

interface JobResponse {
  id: string
  status: "queued" | "running" | "done" | "error"
  progreso: number
  errorMsg?: string
}

interface EvidenciasModalProps {
  fichaId: string
  fichaCodigo: string
  fichaNombre: string
  open: boolean
  onClose: () => void
}

function computeUpdatedText(evidencias: Evidencia[]): { text: string; stale: boolean } {
  const fechas = evidencias
    .map((e) => e.ultimoScan)
    .filter(Boolean)
    .map((s) => new Date(s!).getTime())

  if (!fechas.length) {
    return { text: "Sin escaneos previos · pulsa Refrescar", stale: true }
  }

  const maxMs = Math.max(...fechas)
  const stale = Date.now() - maxMs > 24 * 60 * 60 * 1000
  return {
    text: `Actualizado ${tiempoRelativo(maxMs)} · datos en caché`,
    stale,
  }
}

export default function EvidenciasModal({
  fichaId,
  fichaCodigo,
  fichaNombre,
  open,
  onClose,
}: EvidenciasModalProps) {
  const queryClient = useQueryClient()
  const [verCerradas, setVerCerradas] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [scanStatus, setScanStatus] = useState("")
  const [scanLoading, setScanLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    return () => stopPoll()
  }, [])

  useEffect(() => {
    if (!open) {
      stopPoll()
      setScanStatus("")
      setScanLoading(false)
      setExpandedId(null)
    }
  }, [open])

  const { data, isLoading, error } = useQuery<EvidenciasResponse>({
    queryKey: ["evidencias", fichaId, verCerradas],
    queryFn: () =>
      apiFetch<EvidenciasResponse>(
        `/api/fichas/${encodeURIComponent(fichaId)}/evidencias${verCerradas ? "?incluirCerradas=1" : ""}`
      ),
    enabled: open,
    staleTime: 60 * 1000,
  })

  const cerrarMutation = useMutation({
    mutationFn: ({ evidenciaId, cerrada }: { evidenciaId: string; cerrada: boolean }) =>
      apiFetch(`/api/evidencias/${encodeURIComponent(evidenciaId)}`, {
        method: "PATCH",
        body: JSON.stringify({ cerrada }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["evidencias", fichaId] }),
    onError: (err) => {
      if (err instanceof ApiError) setScanStatus(`Error: ${err.message}`)
    },
  })

  async function handleScan() {
    setScanLoading(true)
    setScanStatus("Iniciando escaneo...")
    stopPoll()

    try {
      const res = await authFetch(
        `/api/fichas/${encodeURIComponent(fichaId)}/evidencias/scan`,
        { method: "POST", body: "{}" }
      )
      const resData = await res.json()
      if (!res.ok) {
        setScanStatus(resData.error || "Error al iniciar el escaneo.")
        setScanLoading(false)
        return
      }
      startPoll(resData.jobId)
    } catch (err) {
      setScanStatus(err instanceof Error ? err.message : "Error inesperado.")
      setScanLoading(false)
    }
  }

  function startPoll(jobId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        const jobData: JobResponse = await res.json()

        if (!res.ok) {
          stopPoll()
          setScanStatus(jobData.errorMsg || "Error consultando job.")
          setScanLoading(false)
          return
        }

        if (jobData.status === "done") {
          stopPoll()
          setScanStatus("Escaneo completo.")
          setScanLoading(false)
          queryClient.invalidateQueries({ queryKey: ["evidencias", fichaId] })
        } else if (jobData.status === "error") {
          stopPoll()
          setScanStatus(jobData.errorMsg || "El escaneo falló.")
          setScanLoading(false)
        } else {
          setScanStatus(`Escaneando... ${jobData.progreso || 0}%`)
        }
      } catch (err) {
        stopPoll()
        setScanStatus(err instanceof Error ? err.message : "Error de red.")
        setScanLoading(false)
      }
    }, 3000)
  }

  const evidencias = data?.evidencias ?? []
  const cerradasCount = data?.cerradasCount ?? 0
  const { text: updatedText, stale: isStale } = computeUpdatedText(evidencias)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex flex-col p-0 gap-0 overflow-hidden max-h-[90vh]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-200 shrink-0">
          <DialogTitle className="text-base font-semibold text-gray-900">
            Evidencias · {fichaCodigo}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-600 mt-0.5">
            {fichaNombre}
          </DialogDescription>
          <p className={`text-xs mt-1.5 ${isStale ? "text-amber-600" : "text-gray-400"}`}>
            {updatedText}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <p className="text-sm text-gray-500 text-center py-10">
              Cargando evidencias...
            </p>
          ) : error ? (
            <p className="text-sm text-red-500 text-center py-10">
              Error al cargar evidencias.
            </p>
          ) : evidencias.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">
              {verCerradas
                ? "No hay evidencias en esta ficha. Pulsa «Refrescar»."
                : cerradasCount > 0
                ? `Todas las evidencias están cerradas (${cerradasCount}). Activa «Ver cerradas».`
                : "Aún no hay evidencias escaneadas. Pulsa «Refrescar»."}
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {evidencias.map((ev) => (
                <EvidenciaRow
                  key={ev.id}
                  evidencia={ev}
                  expanded={expandedId === ev.id}
                  onToggleExpand={() =>
                    setExpandedId(expandedId === ev.id ? null : ev.id)
                  }
                  onCerrar={(cerrada) =>
                    cerrarMutation.mutate({ evidenciaId: ev.id, cerrada })
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 shrink-0 bg-gray-50 flex items-center gap-3">
          <div className="flex items-center gap-2 mr-auto">
            <Switch
              id="ver-cerradas-modal"
              checked={verCerradas}
              onCheckedChange={setVerCerradas}
            />
            <Label
              htmlFor="ver-cerradas-modal"
              className="text-xs text-gray-600 cursor-pointer"
            >
              Ver cerradas ({cerradasCount})
            </Label>
          </div>

          {scanStatus && (
            <span
              className={`text-xs truncate max-w-[200px] ${
                scanLoading ? "text-blue-600" : "text-gray-600"
              }`}
            >
              {scanStatus}
            </span>
          )}

          <Button
            size="sm"
            className="gap-1.5 bg-sena-green hover:bg-sena-green/90 shrink-0"
            onClick={handleScan}
            disabled={scanLoading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanLoading ? "animate-spin" : ""}`} />
            Refrescar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface EvidenciaRowProps {
  evidencia: Evidencia
  expanded: boolean
  onToggleExpand: () => void
  onCerrar: (cerrada: boolean) => void
}

function EvidenciaRow({
  evidencia: ev,
  expanded,
  onToggleExpand,
  onCerrar,
}: EvidenciaRowProps) {
  return (
    <div className={ev.cerradaAt ? "opacity-60" : ""}>
      <div className="flex items-start gap-3 px-6 py-3 hover:bg-gray-50 transition-colors">
        {/* Left */}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-gray-800 truncate">{ev.nombre}</div>
          <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>Total: {ev.total}</span>
            {ev.ultimoScan && (
              <span>· {new Date(ev.ultimoScan).toLocaleString("es-CO")}</span>
            )}
            {ev.cerradaAt && (
              <span>
                · cerrada {new Date(ev.cerradaAt).toLocaleDateString("es-CO")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            <Badge variant="yellow" className="text-xs">
              Pendientes {ev.pendientes}
            </Badge>
            <Badge variant="green" className="text-xs">
              Calificados {ev.calificados}
            </Badge>
            <Badge variant="gray" className="text-xs">
              Sin entregar {ev.sinEntregar}
            </Badge>
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex gap-1.5 items-center shrink-0 pt-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7 px-2 gap-1"
            onClick={onToggleExpand}
          >
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            Aprendices
          </Button>

          {ev.href && (
            <Button variant="ghost" size="sm" className="text-xs h-7 px-2 gap-1" asChild>
              <a href={ev.href} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-3.5 h-3.5" />
                Zajuna
              </a>
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7 px-2"
            onClick={() => onCerrar(ev.cerradaAt === null)}
          >
            {ev.cerradaAt ? "Reabrir" : "Cerrar"}
          </Button>
        </div>
      </div>

      {expanded && <AprendicesPanel evidenciaId={ev.id} />}
    </div>
  )
}
