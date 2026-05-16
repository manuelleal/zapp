import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, RefreshCw, Zap, Settings } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { apiFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"
import ConfigEvidenciaDialog from "@/components/ConfigEvidenciaDialog"

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

export default function EvidenciasConfig() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed]           = useState<Record<string, boolean>>({})
  const [fullScanStatus, setFullScanStatus] = useState("")
  const [configDialog, setConfigDialog]     = useState<{ id: string; nombre: string; tipo: string } | null>(null)

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

  const fichas = data?.fichas ?? []
  const totalActivas = scanStatus?.activeCount ?? 0

  return (
    <Layout>
      <div className="space-y-4">
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
              const isCollapsed  = collapsed[f.id] ?? true
              const evOrdenadas  = [...f.evidencias].sort((a, b) => gaNum(a.nombre) - gaNum(b.nombre) || a.nombre.localeCompare(b.nombre))
              const evActivas    = evOrdenadas.filter(ev => ev.activaParaScan).length
              const todosIds     = evOrdenadas.map(ev => ev.id)
              const todasActivas = evActivas === evOrdenadas.length && evOrdenadas.length > 0

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
                        agruparPorGA(evOrdenadas).map(grupo => (
                          <div key={grupo.gaKey}>
                            {/* Sub-encabezado por guía */}
                            <div className="px-5 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{grupo.label}</span>
                              <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                                <span className="text-xs text-gray-400">
                                  {grupo.items.filter(e => e.activaParaScan).length}/{grupo.items.length} activas
                                </span>
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
                              <div key={ev.id} className="px-5 py-2.5 flex items-center gap-3 border-b border-gray-50 last:border-0 hover:bg-gray-50">
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
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

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
    </Layout>
  )
}
