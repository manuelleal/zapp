import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, RefreshCw, Zap, Settings, CheckSquare, Square, Calendar, X, CheckCircle, AlertCircle, Loader2, SlidersHorizontal, Search, Archive, ArchiveRestore } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { apiFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"
import ConfigEvidenciaDialog from "@/components/ConfigEvidenciaDialog"
import BatchConfigModal, { BatchCambios } from "@/components/BatchConfigModal"
import ConfigTabla from "@/components/ConfigTabla"
import { usePollJob } from "@/hooks/usePollJob"
import { tiempoRelativo, gaNum } from "@/lib/utils"

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

// ─── Componente principal ─────────────────────────────────────────────────────

export default function EvidenciasConfig() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  // ── State existente ───────────────────────────────────────────────────────
  const [collapsed, setCollapsed]           = useState<Record<string, boolean>>({})
  const [fullScanStatus, setFullScanStatus] = useState("")
  const [configDialog, setConfigDialog]     = useState<{ id: string; nombre: string; tipo: string } | null>(null)
  
  // ── State UI / Filtros (Fase 2) ──────────────────────────────────────────
  const [searchQuery, setSearchQuery]       = useState("")
  const [filterMode, setFilterMode]         = useState<"all" | "active" | "inactive">("all")
  const [collapsedGuias, setCollapsedGuias] = useState<Record<string, boolean>>({})
  // Chip de ficha activa: "all" = todas, o el id de una ficha (estilo Dashboard).
  const [selectedFichaId, setSelectedFichaId] = useState<string>("all")
  // Vista: "lista" (activar/archivar) o "tabla" (editar fechas/intentos inline).
  const [viewMode, setViewMode] = useState<"lista" | "tabla">("lista")

  // Guías archivadas (preferencia de vista, persistida en localStorage). Cada
  // entrada es la clave `${fichaId}-${gaKey}`. Archivar oculta la guía del
  // listado principal; se puede restaurar desde la sección "Guías archivadas".
  const ARCHIVED_GUIAS_KEY = "zajuna_archived_guias"
  const [archivedGuias, setArchivedGuias] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ARCHIVED_GUIAS_KEY)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch { return new Set() }
  })
  // Mostrar/ocultar la sección de archivadas por ficha.
  const [showArchivadas, setShowArchivadas] = useState<Record<string, boolean>>({})

  function persistArchived(next: Set<string>) {
    setArchivedGuias(next)
    try { localStorage.setItem(ARCHIVED_GUIAS_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
  }
  function archivarGuia(fichaId: string, gaKey: number) {
    const next = new Set(archivedGuias); next.add(`${fichaId}-${gaKey}`); persistArchived(next)
  }
  function restaurarGuia(fichaId: string, gaKey: number) {
    const next = new Set(archivedGuias); next.delete(`${fichaId}-${gaKey}`); persistArchived(next)
  }

  function toggleGuiaCollapse(fichaId: string, gaKey: number) {
    const key = `${fichaId}-${gaKey}`
    // Las guías arrancan PLEGADAS por defecto (undefined ⇒ colapsada). Por eso
    // el primer clic sobre una guía sin estado debe EXPANDIRLA (poner false).
    setCollapsedGuias(c => ({ ...c, [key]: c[key] === undefined ? false : !c[key] }))
  }

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
    setCollapsed(c => ({ ...c, [fichaId]: !(c[fichaId] ?? true) }))
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

        {/* Barra de Filtro y Búsqueda */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col md:flex-row md:items-center gap-4">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por código de competencia (ej. 240202501) o nombre..."
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sena-green/50 focus:border-sena-green transition-shadow"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="w-4 h-4 text-gray-400 hover:text-gray-600" />
              </button>
            )}
          </div>
          
          <div className="flex items-center gap-2 bg-gray-100/50 p-1 rounded-md border border-gray-200">
            <button
              onClick={() => setFilterMode("all")}
              className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${filterMode === "all" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
            >
              Todas
            </button>
            <button
              onClick={() => setFilterMode("active")}
              className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${filterMode === "active" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
            >
              Mis Activas
            </button>
            <button
              onClick={() => setFilterMode("inactive")}
              className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${filterMode === "inactive" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
            >
              Inactivas
            </button>
          </div>
        </div>

        {/* Chips de ficha — navegación rápida (estilo Dashboard) */}
        {fichas.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelectedFichaId("all")}
              className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${
                selectedFichaId === "all"
                  ? "bg-sena-green text-white border-sena-green"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
            >
              Todas las fichas
            </button>
            {fichas.map(f => (
              <button
                key={f.id}
                onClick={() => setSelectedFichaId(f.id)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${
                  selectedFichaId === f.id
                    ? "bg-sena-green text-white border-sena-green"
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                }`}
              >
                Ficha {f.codigo}
              </button>
            ))}

            {/* Toggle de vista Lista / Tabla */}
            <div className="ml-auto flex items-center gap-1 bg-gray-100/60 p-1 rounded-md border border-gray-200">
              <button
                onClick={() => setViewMode("lista")}
                className={`px-3 py-1 text-sm font-medium rounded-sm transition-colors ${viewMode === "lista" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
              >
                Lista
              </button>
              <button
                onClick={() => setViewMode("tabla")}
                className={`px-3 py-1 text-sm font-medium rounded-sm transition-colors ${viewMode === "tabla" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
              >
                Tabla de fechas
              </button>
            </div>
          </div>
        )}

        {/* Barra de Acciones Masivas (M2) */}
        {selectedCount > 0 && (
          <div className="bg-sena-green/10 border border-sena-green/30 rounded-lg p-3 flex items-center justify-between sticky top-4 z-10 shadow-sm backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-sena-green" />
              <span className="text-sm font-medium text-sena-green-dark">
                {selectedCount} evidencia{selectedCount !== 1 ? "s" : ""} seleccionada{selectedCount !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs bg-white text-gray-700 hover:bg-gray-50 border-gray-300"
                onClick={cancelarSeleccion}
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
                onClick={() => bulkMutation.mutate({ ids: Array.from(selectedIds), activa: false })}
                disabled={bulkMutation.isPending}
              >
                Desactivar seleccionadas
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs bg-sena-green hover:bg-sena-green/90 text-white"
                onClick={() => bulkMutation.mutate({ ids: Array.from(selectedIds), activa: true })}
                disabled={bulkMutation.isPending}
              >
                Activar seleccionadas
              </Button>
            </div>
          </div>
        )}

        {/* Vista TABLA: editor de fechas/intentos inline por ficha (B2) */}
        {viewMode === "tabla" && (
          selectedFichaId === "all"
            ? <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-sm text-gray-500">Selecciona una ficha arriba para editar sus fechas en tabla.</div>
            : <ConfigTabla fichaId={selectedFichaId} />
        )}

        {/* Fichas + evidencias (vista LISTA) */}
        {viewMode === "lista" && (isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">Cargando evidencias...</div>
        ) : fichas.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center">
            <p className="text-gray-600 text-sm">No hay fichas. Ve al módulo de Fichas para agregar.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {fichas
              .filter(f => selectedFichaId === "all" || f.id === selectedFichaId)
              .map(f => {
              const isCollapsed    = collapsed[f.id] ?? false
              
              // Filtrar evidencias según query y modo
              const query = searchQuery.toLowerCase().trim()
              let evOrdenadas = [...f.evidencias].sort((a, b) => gaNum(a.nombre) - gaNum(b.nombre) || a.nombre.localeCompare(b.nombre))
              
              if (filterMode === "active")   evOrdenadas = evOrdenadas.filter(e => e.activaParaScan)
              if (filterMode === "inactive") evOrdenadas = evOrdenadas.filter(e => !e.activaParaScan)
              if (query) {
                evOrdenadas = evOrdenadas.filter(e => e.nombre.toLowerCase().includes(query) || e.tipo.toLowerCase().includes(query))
              }
              
              const evActivas      = f.evidencias.filter(ev => ev.activaParaScan).length
              const todosIds       = evOrdenadas.map(ev => ev.id)
              const todasActivas   = evOrdenadas.every(ev => ev.activaParaScan) && evOrdenadas.length > 0
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
                      <span className="text-xs text-gray-400">{evActivas}/{f.evidencias.length} activas en ficha</span>
                      {evOrdenadas.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className={`h-6 text-xs px-2 ${todasActivas ? "text-gray-500 hover:text-red-600" : "text-sena-green border-sena-green/30 bg-sena-green/5 hover:bg-sena-green/10 hover:border-sena-green/50"}`}
                          onClick={(e) => { e.stopPropagation(); bulkMutation.mutate({ ids: todosIds, activa: !todasActivas }) }}
                          disabled={bulkMutation.isPending}
                        >
                          <Zap className="w-3 h-3 mr-1" />
                          {todasActivas ? "Desactivar filtradas" : "Activar filtradas"}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Evidencias agrupadas por Guía */}
                  {!isCollapsed && (
                    <div className="border-t border-gray-100">
                      {evOrdenadas.length === 0 ? (
                        <p className="px-5 py-4 text-sm text-gray-400">
                          {searchQuery ? "No se encontraron evidencias con ese código/nombre." : "No hay evidencias en esta vista."}
                        </p>
                      ) : (
                        agruparPorGA(evOrdenadas)
                          .filter(grupo => !archivedGuias.has(`${f.id}-${grupo.gaKey}`))
                          .map(grupo => {
                          const grupoIds     = grupo.items.map(e => e.id)
                          const grupoAllSel  = grupoIds.every(id => selectedIds.has(id))
                          const guiaKey      = `${f.id}-${grupo.gaKey}`
                          // Default PLEGADA: evita el "mamotreto" de todo abierto.
                          const isGuiaColapsada = collapsedGuias[guiaKey] ?? true

                          return (
                            <div key={grupo.gaKey}>
                              {/* Sub-encabezado por guía */}
                              <div 
                                className="px-5 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100/70 select-none"
                                onClick={() => toggleGuiaCollapse(f.id, grupo.gaKey)}
                              >
                                <div className="flex items-center gap-2">
                                  {isGuiaColapsada
                                    ? <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                                    : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                                  <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{grupo.label}</span>
                                </div>
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
                                  {/* Archivar guía (ocultarla del listado) */}
                                  <button
                                    className="text-gray-400 hover:text-amber-600"
                                    title="Archivar esta guía (ocultarla del listado)"
                                    onClick={() => archivarGuia(f.id, grupo.gaKey)}
                                  >
                                    <Archive className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                              {/* Evidencias de este grupo */}
                              {!isGuiaColapsada && grupo.items.map(ev => (
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

                      {/* Sección de guías archivadas (restaurables) */}
                      {(() => {
                        const archivados = agruparPorGA(evOrdenadas).filter(g => archivedGuias.has(`${f.id}-${g.gaKey}`))
                        if (archivados.length === 0) return null
                        const abierto = showArchivadas[f.id] ?? false
                        return (
                          <div className="bg-gray-50/60 border-t border-gray-100">
                            <button
                              className="w-full px-5 py-2 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 select-none"
                              onClick={() => setShowArchivadas(s => ({ ...s, [f.id]: !abierto }))}
                            >
                              <Archive className="w-3.5 h-3.5" />
                              {archivados.length} guía{archivados.length !== 1 ? "s" : ""} archivada{archivados.length !== 1 ? "s" : ""}
                              {abierto ? <ChevronDown className="w-3.5 h-3.5 ml-auto" /> : <ChevronRight className="w-3.5 h-3.5 ml-auto" />}
                            </button>
                            {abierto && archivados.map(grupo => (
                              <div key={grupo.gaKey} className="px-5 py-2 flex items-center justify-between border-t border-gray-100">
                                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{grupo.label}</span>
                                <button
                                  className="text-xs text-sena-green hover:underline flex items-center gap-1"
                                  onClick={() => restaurarGuia(f.id, grupo.gaKey)}
                                >
                                  <ArchiveRestore className="w-3.5 h-3.5" />
                                  Restaurar
                                </button>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
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
                  Configurar seleccionadas ({selectedCount})
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
