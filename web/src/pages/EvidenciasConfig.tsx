import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, RefreshCw, Zap } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { apiFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

interface Evidencia {
  id: string
  nombre: string
  href: string
  tipo: string
  cerradaAt: string | null
  activaParaScan: boolean
  ultimoScan: string | null
  pendientes: number
  calificados: number
  sinEntregar: number
  total: number
}

interface FichaConEvidencias {
  id: string
  codigo: string
  nombre: string
  archivedAt: string | null
  evidencias: Evidencia[]
  cerradasCount: number
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

function tipoBadge(tipo: string) {
  const map: Record<string, string> = { assign: "Tarea", forum: "Foro", quiz: "Quiz" }
  const colors: Record<string, string> = { assign: "blue", forum: "purple", quiz: "yellow" }
  return <Badge variant={(colors[tipo] as "blue" | "purple" | "yellow") || "gray"} className="text-xs">{map[tipo] || tipo}</Badge>
}

export default function EvidenciasConfig() {
  const navigate = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [fullScanStatus, setFullScanStatus] = useState("")

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

  const { data: fichasData, isLoading } = useQuery<{ fichas: FichaConEvidencias[]; archivadasCount: number }>({
    queryKey: ["fichas-config"],
    queryFn:  () => apiFetch<{ fichas: FichaConEvidencias[]; archivadasCount: number }>("/api/fichas?incluirArchivadas=1").then(async (fichasRes) => {
      // Para cada ficha activa, traer sus evidencias
      const fichasConEv = await Promise.all(
        fichasRes.fichas.map(async f => {
          if (f.archivedAt) return { ...f, evidencias: [], cerradasCount: 0 }
          const ev = await apiFetch<{ evidencias: Evidencia[]; cerradasCount: number }>(
            `/api/fichas/${f.id}/evidencias?incluirCerradas=1`
          ).catch(() => ({ evidencias: [], cerradasCount: 0 }))
          return { ...f, ...ev }
        })
      )
      return { fichas: fichasConEv, archivadasCount: fichasRes.fichas.filter(f => f.archivedAt).length }
    }),
    enabled: !!jwt,
    retry: false,
  })

  const { data: scanStatus } = useQuery<ScanStatus>({
    queryKey: ["scan-status"],
    queryFn:  () => apiFetch("/api/scan/status"),
    enabled:  !!jwt,
    refetchInterval: 30_000,
  })

  const activarMutation = useMutation({
    mutationFn: ({ id, activa }: { id: string; activa: boolean }) =>
      apiFetch(`/api/evidencias/${encodeURIComponent(id)}/activar`, { method: "PATCH", body: JSON.stringify({ activa }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["fichas-config"] }),
  })

  const activarBulkMutation = useMutation({
    mutationFn: ({ ids, activa }: { ids: string[]; activa: boolean }) =>
      apiFetch("/api/evidencias/activar/bulk", { method: "PATCH", body: JSON.stringify({ ids, activa }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fichas-config"] })
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
    },
  })

  async function handleFullScan() {
    if (!confirm("Esto escaneará TODAS tus evidencias, incluyendo las no activas. ¿Continuar?")) return
    setFullScanStatus("Iniciando escaneo completo...")
    try {
      await apiFetch("/api/scan/full", { method: "POST" })
      setFullScanStatus("Escaneo completo iniciado. Puede tardar varios minutos.")
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
    } catch (err) {
      setFullScanStatus(err instanceof ApiError ? err.message : "Error al iniciar escaneo.")
    }
  }

  const fichas = fichasData?.fichas ?? []
  const totalActivas = scanStatus?.activeCount ?? 0

  function toggleCollapse(fichaId: string) {
    setCollapsed(c => ({ ...c, [fichaId]: !c[fichaId] }))
  }

  function allIdsForFicha(f: FichaConEvidencias) {
    return f.evidencias.filter(ev => !ev.cerradaAt).map(ev => ev.id)
  }

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
            <span className="text-sm text-gray-500">
              Último scan: {tiempoRelativo(scanStatus.lastAutoScanAt)}
            </span>
          )}
          {scanStatus?.nextAutoScanAt && (
            <span className="text-sm text-gray-500">
              Próximo: {tiempoRelativo(scanStatus.nextAutoScanAt)}
            </span>
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
              const isCollapsed = collapsed[f.id] ?? false
              const evActivas   = f.evidencias.filter(ev => ev.activaParaScan && !ev.cerradaAt).length
              const evTotal     = f.evidencias.filter(ev => !ev.cerradaAt).length

              return (
                <div key={f.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {/* Header ficha */}
                  <div
                    className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 select-none"
                    onClick={() => toggleCollapse(f.id)}
                  >
                    {isCollapsed ? <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                    <span className="font-mono text-sm font-semibold text-gray-800">{f.codigo}</span>
                    {f.nombre && <span className="text-sm text-gray-600 truncate">{f.nombre}</span>}
                    {f.archivedAt && <Badge variant="gray" className="text-xs ml-1">Archivada</Badge>}
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-gray-500">{evActivas}/{evTotal} activas</span>
                      {!f.archivedAt && evTotal > 0 && (
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                          <Button variant="outline" size="sm" className="h-6 text-xs px-2"
                            onClick={() => activarBulkMutation.mutate({ ids: allIdsForFicha(f), activa: true })}>
                            Activar todas
                          </Button>
                          <Button variant="outline" size="sm" className="h-6 text-xs px-2"
                            onClick={() => activarBulkMutation.mutate({ ids: allIdsForFicha(f), activa: false })}>
                            Desactivar
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Evidencias */}
                  {!isCollapsed && !f.archivedAt && (
                    <div className="border-t border-gray-100">
                      {f.evidencias.length === 0 ? (
                        <p className="px-5 py-3 text-sm text-gray-400">Sin evidencias escaneadas aún. Haz un escaneo completo.</p>
                      ) : (
                        f.evidencias.filter(ev => !ev.cerradaAt).map(ev => (
                          <div key={ev.id} className="px-5 py-2.5 flex items-center gap-3 border-b border-gray-50 last:border-0 hover:bg-gray-50">
                            <Switch
                              checked={ev.activaParaScan}
                              onCheckedChange={activa => activarMutation.mutate({ id: ev.id, activa })}
                            />
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm truncate ${ev.activaParaScan ? "text-gray-800" : "text-gray-400"}`}>{ev.nombre}</p>
                              <p className="text-xs text-gray-400">{tiempoRelativo(ev.ultimoScan)}</p>
                            </div>
                            {tipoBadge(ev.tipo)}
                            {ev.total > 0 && (
                              <div className="flex gap-2 text-xs text-gray-500 flex-shrink-0">
                                {ev.pendientes > 0 && <span className="text-red-600 font-medium">{ev.pendientes} pend.</span>}
                                {ev.calificados > 0 && <span className="text-green-600">{ev.calificados} cal.</span>}
                              </div>
                            )}
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
    </Layout>
  )
}
