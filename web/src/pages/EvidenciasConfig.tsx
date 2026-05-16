import { useState, useEffect, useRef } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, RefreshCw, Zap, Settings, CheckSquare, Square, Calendar, X, CheckCircle, AlertCircle, Loader2, SlidersHorizontal } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { apiFetch, authFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"
import ConfigEvidenciaDialog from "@/components/ConfigEvidenciaDialog"
import BatchConfigModal, { BatchCambios } from "@/components/BatchConfigModal"

interface Evidencia {
  id: string
  nombre: string
  tipo: string
  activaParaScan: boolean
  pendientes: number
  calificados: number
  sinEntregar: number
  total: number
  ultimoScan: string | null
}

interface FichaConEvidencias {
  id: string
  codigo: string
  nombre: string
  evidencias: Evidencia[]
}

interface ScanStatus {
  lastAutoScanAt: string | null
  nextAutoScanAt: string | null
  activeCount: number
}

type BatchPhase = "idle" | "confirm" | "running" | "done" | "error"

function tiempoRelativo(fecha: string | null): string {
  if (!fecha) return "Nunca"
  const diff = Date.now() - new Date(fecha).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Hace un momento"
  if (mins < 60) return `Hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `Hace ${hrs}h`
  return `Hace ${Math.floor(hrs / 24)}d`
}

function gaNum(nombre: string): number {
  const m = nombre.match(/GA(\d+)/i)
  return m ? parseInt(m[1]) : 999
}

function agruparPorGA(evidencias: Evidencia[]): { label: string; gaKey: number; items: Evidencia[] }[] {
  const mapa: Record<number, Evidencia[]> = {}
  for (const ev of evidencias) {
    const n = gaNum(ev.nombre)
    if (!mapa[n]) mapa[n] = []
    mapa[n].push(ev)
  }
  return Object.entries(mapa)
    .map(([k, items]) => ({ gaKey: Number(k), label: Number(k) === 999 ? "Otras" : `Guía ${k}`, items }))
    .sort((a, b) => a.gaKey - b.gaKey)
}

function tipoBadge(tipo: string) {
  const map: Record<string, string> = { assign: "Tarea", forum: "Foro", quiz: "Quiz" }
  const colors: Record<string, "blue" | "purple" | "yellow" | "gray"> = {
    assign: "blue", forum: "purple", quiz: "yellow",
  }
  return (
    <Badge variant={colors[tipo] ?? "gray"} className="text-xs flex-shrink-0">
      {map[tipo] ?? tipo}
    </Badge>
  )
}

// ─── Polling hook reutilizable ────────────────────────────────────────────────

function usePollJob() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stop() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }

  function start(
    jobId: string,
    onDone:     (resultado: unknown) => void,
    onError:    (msg: string) => void,
    onProgress?: (p: number) => void,
  ) {
    stop()
    intervalRef.current = setInterval(async () => {
      try {
        const res  = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        const data = await res.json()
        if (!res.ok) { stop(); onError(data?.errorMsg || `Error ${res.status}`); return }
        if (data.status === "done")  { stop(); onDone(data.resultado) }
        else if (data.status === "error") { stop(); onError(data.errorMsg || "El job falló.") }
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

// ─── Componente principal ─────────────────────────────────────────────────────

export default function EvidenciasConfig() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  // ── State existente ───────────────────────────────────────────────────────
  const [collapsed, setCollapsed]           = useState<Record<string, boolean>>({})
  const [fullScanStatus, setFullScanStatus] = useState("")
  const [configDialog, setConfigDialog]     = useState<{ id: string; nombre: string; tipo: string } | null>(null)

  // ── State bulk duedate (M2) ───────────────────────────────────────────────
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [nuevaFecha, setNuevaFecha]     = useState("")
  const [batchPhase, setBatchPhase]     = useState<BatchPhase>("idle")
  const [batchMsg, setBatchMsg]         = useState("")
  const [batchDetalle, setBatchDetalle] = useState<{ evidenciaId: string; ok: boolean; nombre?: string; error?: string }[]>([])
  const pollBatch = usePollJob()

  // ── State batch config genérico (M3) ─────────────────────────────────────
  const [batchConfigOpen, setBatchConfigOpen]   = useState(false)
  const [batchConfigBusy, setBatchConfigBusy]   = useState(false)
  const [batchConfigError, setBatchConfigError] = useState("")
  const pollBatchConfig = usePollJob()

  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, { id: payload.id || "", nombre: payload.nombre || "", email: payload.email || "", competenciaNombre: payload.competenciaNombre || "", competenciaCodigo: payload.competenciaCodigo || "" })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  const { data, isLoading } = useQuery<{ fichas: FichaConEvidencias[] }>({
    queryKey: ["evidencias-todas"],
    queryFn:  () => apiFetch<{ fichas: FichaConEvidencias[] }>("/api/evidencias/todas"),
    enabled:  !!jwt,
    retry:    false,
  })

  const { data: scanStatus } = useQuery<ScanStatus>({
    queryKey: ["scan-status"],
    queryFn:  () => apiFetch("/api/scan/status"),
    enabled:  !!jwt,
    refetchInterval: 30_000,
  })

  const activarMutation = useMutation({
    mutationFn: ({ id, activa }: { id: string; activa: boolean }) =>
      apiFetch(`/api/evidencias/${encodeURIComponent(id)}/activar`, {
        method: "PATCH", body: JSON.stringify({ activa }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["evidencias-todas"] })
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
    },
  })

  const bulkMutation = useMutation({
    mutationFn: ({ ids, activa }: { ids: string[]; activa: boolean }) =>
      apiFetch("/api/evidencias/activar/bulk", {
        method: "PATCH", body: JSON.stringify({ ids, activa }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["evidencias-todas"] })
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
    },
  })

  async function handleFullScan() {
    if (!confirm("Esto escaneará TODAS tus evidencias, incluyendo las no activas. ¿Continuar?")) return
    setFullScanStatus("Iniciando escaneo completo...")
    try {
      await apiFetch("/api/scan/full", { method: "POST" })
      setFullScanStatus("Escaneo iniciado. Puede tardar varios minutos.")
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
    } catch (err) {
      setFullScanStatus(err instanceof ApiError ? err.message : "Error al iniciar escaneo.")
    }
  }

  function toggleCollapse(fichaId: string) {
    setCollapsed(c => ({ ...c, [fichaId]: !c[fichaId] }))
  }

  // ── Helpers de selección (M2) ─────────────────────────────────────────────

  function toggleSelect(evId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(evId)) next.delete(evId)
      else next.add(evId)
      return next
    })
  }

  function toggleFichaSelect(evIds: string[]) {
    const todosSeleccionados = evIds.every(id => selectedIds.has(id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (todosSeleccionados) evIds.forEach(id => next.delete(id))
      else evIds.forEach(id => next.add(id))
      return next
    })
  }

  function cancelarSeleccion() {
    setSelectedIds(new Set())
    setNuevaFecha("")
    setBatchPhase("idle")
    setBatchMsg("")
    setBatchDetalle([])
    pollBatch.stop()
  }

  async function handleBatchDuedate() {
    if (!nuevaFecha) {
      setBatchMsg("Selecciona una fecha de cierre.")
      return
    }
    const ids = Array.from(selectedIds)
    setBatchPhase("running")
    setBatchMsg(`Procesando ${ids.length} evidencia(s)...`)
    setBatchDetalle([])
    try {
      const resp = await apiFetch<{ jobId: string; total: number }>("/api/evidencias/batch/duedate", {
        method: "POST",
        body:   JSON.stringify({ evidenciaIds: ids, nuevaFecha }),
      })
      pollBatch.start(
        resp.jobId,
        (resultado: unknown) => {
          const r = resultado as { exitosas: number; fallidas: number; total: number; detalle: typeof batchDetalle }
          setBatchPhase("done")
          setBatchMsg(`Completado: ${r.exitosas} exitosas, ${r.fallidas} con error.`)
          setBatchDetalle(r.detalle || [])
        },
        (msg) => {
          setBatchPhase("error")
          setBatchMsg(msg)
        },
        (p) => setBatchMsg(`Procesando... ${p}%`)
      )
    } catch (e) {
      setBatchPhase("error")
      setBatchMsg(e instanceof ApiError ? e.message : "Error al iniciar el batch.")
    }
  }

  async function handleBatchConfig(cambios: BatchCambios) {
    const ids = Array.from(selectedIds)
    setBatchConfigBusy(true)
    setBatchConfigError("")
    try {
      const resp = await apiFetch<{ jobId: string; total: number }>("/api/evidencias/batch/config", {
        method: "POST",
        body:   JSON.stringify({ evidenciaIds: ids, cambios }),
      })
      pollBatchConfig.start(
        resp.jobId,
        (resultado: unknown) => {
          const r = resultado as { exitosas: number; fallidas: number; total: number; detalle: typeof batchDetalle }
          setBatchConfigBusy(false)
          setBatchConfigOpen(false)
          setBatchPhase("done")
          setBatchMsg(`Config aplicada: ${r.exitosas} exitosas, ${r.fallidas} con error.`)
          setBatchDetalle(r.detalle || [])
          setSelectedIds(new Set())
        },
        (msg) => {
          setBatchConfigBusy(false)
          setBatchConfigError(msg)
        },
      )
    } catch (e) {
      setBatchConfigBusy(false)
      setBatchConfigError(e instanceof ApiError ? e.message : "Error al iniciar configuración batch.")
    }
  }

  const fichas         = data?.fichas ?? []
  const totalActivas   = scanStatus?.activeCount ?? 0
  const selectedCount  = selectedIds.size
  const batchBusy      = batchPhase === "running"

  // ── Obtener todos los ids disponibles para la ficha (para select-all por ficha) ──
  function getEvidenciaIdsDeficha(f: FichaConEvidencias) {
    return [...f.evidencias].map(ev => ev.id)
  }

  return (
    <Layout>
      <div className="space-y-4 pb-24">
        {/* Info bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-sena-green" />
            <span className="text-sm font-medium text-gray-700">
              {totalActivas} evidencia{totalActivas !== 1 ? "s" : ""} activas · auto-scan cada 3h
            </span>
          </div>
          {scanStatus?.lastAutoScanAt && (
            <span className="text-sm text-gray-500">Último scan: {tiempoRelativo(scanStatus.lastAutoScanAt)}</span>
          )}
          {scanStatus?.nextAutoScanAt && (
            <span className="text-sm text-gray-500">Próximo: {tiempoRelativo(scanStatus.nextAutoScanAt)}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {fullScanStatus && <span className="text-sm text-gray-600">{fullScanStatus}</span>}
            <Button variant="outline" size="sm" className="gap-2" onClick={handleFullScan}>
              <RefreshCw className="w-3.5 h-3.5" />
              Escaneo completo
            </Button>
          </div>
        </div>

        {/* Fichas + evidencias */}
        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">Cargando evidencias...</div>
        ) : fichas.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center">
            <p className="text-gray-600 text-sm">No hay fichas. Ve al módulo de Fichas para agregar.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {fichas.map(f => {
              const isCollapsed    = collapsed[f.id] ?? false
              const evOrdenadas    = [...f.evidencias].sort((a, b) => gaNum(a.nombre) - gaNum(b.nombre) || a.nombre.localeCompare(b.nombre))
              const evActivas      = evOrdenadas.filter(ev => ev.activaParaScan).length
              const todosIds       = evOrdenadas.map(ev => ev.id)
              const todasActivas   = evActivas === evOrdenadas.length && evOrdenadas.length > 0
              const fichaSelIds    = getEvidenciaIdsDeficha(f)
              const fichaSelCount  = fichaSelIds.filter(id => selectedIds.has(id)).length
              const fichaAllSel    = fichaSelCount === fichaSelIds.length && fichaSelIds.length > 0
              const fichaSomeSel   = fichaSelCount > 0 && !fichaAllSel

              return (
                <div key={f.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {/* Header ficha */}
                  <div
                    className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 select-none"
                    onClick={() => toggleCollapse(f.id)}
                  >
                    {isCollapsed
                      ? <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      : <ChevronDown  className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                    <span className="font-mono text-sm font-semibold text-gray-800">{f.codigo}</span>
                    {f.nombre && <span className="text-sm text-gray-500 truncate flex-1">{f.nombre}</span>}
                    <div className="ml-auto flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      {/* Checkbox select-all para la ficha (M2) */}
                      <div
                        className="flex items-center gap-1 cursor-pointer"
                        title={fichaAllSel ? "Deseleccionar ficha" : "Seleccionar toda la ficha"}
                        onClick={() => toggleFichaSelect(fichaSelIds)}
                      >
                        {fichaAllSel
                          ? <CheckSquare className="w-4 h-4 text-sena-green" />
                          : fichaSomeSel
                          ? <CheckSquare className="w-4 h-4 text-sena-green/60" />
                          : <Square className="w-4 h-4 text-gray-300" />}
                        {fichaSelCount > 0 && (
                          <span className="text-xs text-sena-green font-medium">{fichaSelCount}</span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400">{evActivas}/{evOrdenadas.length} activas</span>
                      {evOrdenadas.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2"
                          onClick={() => bulkMutation.mutate({ ids: todosIds, activa: !todasActivas })}
                          disabled={bulkMutation.isPending}
                        >
                          {todasActivas ? "Desactivar todas" : "Activar todas"}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Evidencias agrupadas por Guía */}
                  {!isCollapsed && (
                    <div className="border-t border-gray-100">
                      {evOrdenadas.length === 0 ? (
                        <p className="px-5 py-4 text-sm text-gray-400">Sin evidencias escaneadas aún. Haz un escaneo completo.</p>
                      ) : (
                        agruparPorGA(evOrdenadas).map(grupo => {
                          const grupoIds     = grupo.items.map(e => e.id)
                          const grupoAllSel  = grupoIds.every(id => selectedIds.has(id))
                          return (
                            <div key={grupo.gaKey}>
                              {/* Sub-encabezado por guía */}
                              <div className="px-5 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{grupo.label}</span>
                                <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                                  <span className="text-xs text-gray-400">
                                    {grupo.items.filter(e => e.activaParaScan).length}/{grupo.items.length} activas
                                  </span>
                                  {/* Select-all por guía (M2) */}
                                  <button
                                    className="text-xs text-blue-500 hover:underline"
                                    title={grupoAllSel ? "Deseleccionar guía" : "Seleccionar guía"}
                                    onClick={() => toggleFichaSelect(grupoIds)}
                                  >
                                    {grupoAllSel ? "Desel." : "Sel."}
                                  </button>
                                  <button
                                    className="text-xs text-sena-green hover:underline"
                                    onClick={() => {
                                      const ids = grupo.items.map(e => e.id)
                                      const allOn = grupo.items.every(e => e.activaParaScan)
                                      bulkMutation.mutate({ ids, activa: !allOn })
                                    }}
                                  >
                                    {grupo.items.every(e => e.activaParaScan) ? "Desactivar" : "Activar"}
                                  </button>
                                </div>
                              </div>
                              {/* Evidencias de este grupo */}
                              {grupo.items.map(ev => (
                                <div key={ev.id} className={`px-5 py-2.5 flex items-center gap-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 ${selectedIds.has(ev.id) ? "bg-blue-50/40" : ""}`}>
                                  {/* Checkbox de selección (M2) */}
                                  <Checkbox
                                    checked={selectedIds.has(ev.id)}
                                    onCheckedChange={() => toggleSelect(ev.id)}
                                    className="shrink-0"
                                    aria-label={`Seleccionar ${ev.nombre}`}
                                  />
                                  <Switch
                                    checked={ev.activaParaScan}
                                    onCheckedChange={activa => activarMutation.mutate({ id: ev.id, activa })}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className={`text-sm truncate ${ev.activaParaScan ? "text-gray-800" : "text-gray-400"}`}>
                                      {ev.nombre}
                                    </p>
                                    <p className="text-xs text-gray-400">{tiempoRelativo(ev.ultimoScan)}</p>
                                  </div>
                                  {tipoBadge(ev.tipo)}
                                  {ev.total > 0 && (
                                    <div className="flex gap-2 text-xs flex-shrink-0">
                                      {ev.pendientes > 0 && <span className="text-red-600 font-medium">{ev.pendientes} pend.</span>}
                                      {ev.calificados > 0 && <span className="text-green-600">{ev.calificados} cal.</span>}
                                    </div>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 gap-1 text-xs text-gray-500 hover:text-gray-800 flex-shrink-0"
                                    onClick={() => setConfigDialog({ id: ev.id, nombre: ev.nombre, tipo: ev.tipo })}
                                    title="Ver configuración en Moodle"
                                  >
                                    <Settings className="w-3.5 h-3.5" />
                                    Ver config
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Barra flotante de batch duedate (M2) ─────────────────────────────── */}
      {selectedCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 shadow-lg px-4 py-3">
          <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-gray-700 shrink-0">
              {selectedCount} evidencia{selectedCount !== 1 ? "s" : ""} seleccionada{selectedCount !== 1 ? "s" : ""}
            </span>

            {batchPhase === "idle" && (
              <>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Calendar className="w-4 h-4 text-gray-400 shrink-0" />
                  <input
                    type="datetime-local"
                    value={nuevaFecha}
                    onChange={e => setNuevaFecha(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring w-48"
                    title="Nueva fecha de entrega"
                  />
                </div>
                <Button
                  size="sm"
                  className="bg-sena-green hover:bg-sena-green/90 gap-1 shrink-0"
                  onClick={() => {
                    if (!nuevaFecha) { setBatchMsg("Selecciona una fecha."); return }
                    setBatchPhase("confirm")
                  }}
                  disabled={!nuevaFecha}
                >
                  Fecha entrega
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 shrink-0"
                  onClick={() => { setBatchConfigError(""); setBatchConfigOpen(true) }}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Config avanzada
                </Button>
              </>
            )}

            {batchPhase === "confirm" && (
              <div className="flex items-center gap-3 flex-1 flex-wrap">
                <span className="text-sm text-gray-700">
                  ¿Cambiar fecha de cierre de <strong>{selectedCount}</strong> evidencias a <strong>{nuevaFecha.replace("T", " ")}</strong>?
                </span>
                <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={handleBatchDuedate}>
                  Confirmar
                </Button>
              </div>
            )}

            {batchPhase === "running" && (
              <div className="flex items-center gap-2 text-sm text-amber-700 flex-1">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>{batchMsg}</span>
              </div>
            )}

            {batchPhase === "done" && (
              <div className="flex flex-col gap-1 flex-1">
                <div className="flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>{batchMsg}</span>
                </div>
                {batchDetalle.filter(d => !d.ok).length > 0 && (
                  <ul className="text-xs text-red-600 pl-6 list-disc">
                    {batchDetalle.filter(d => !d.ok).map(d => (
                      <li key={d.evidenciaId}>{d.nombre || d.evidenciaId}: {d.error}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {batchPhase === "error" && (
              <div className="flex items-center gap-2 text-sm text-red-700 flex-1">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{batchMsg}</span>
              </div>
            )}

            {batchMsg && batchPhase === "idle" && (
              <span className="text-xs text-red-600">{batchMsg}</span>
            )}

            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1 text-gray-500"
              onClick={cancelarSeleccion}
              disabled={batchBusy}
            >
              <X className="w-4 h-4" />
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {configDialog && (
        <ConfigEvidenciaDialog
          open={true}
          onClose={() => setConfigDialog(null)}
          evidenciaIds={[configDialog.id]}
          evidenciaNombre={configDialog.nombre}
          tipos={[configDialog.tipo]}
          readOnly={true}
        />
      )}

      <BatchConfigModal
        open={batchConfigOpen}
        onClose={() => setBatchConfigOpen(false)}
        evidenciaCount={selectedIds.size}
        onSubmit={handleBatchConfig}
        busy={batchConfigBusy}
        error={batchConfigError}
      />
    </Layout>
  )
}
