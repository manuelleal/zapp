import { useState, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, ChevronDown, ChevronRight } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { apiFetch, ApiError } from "@/api/client"
import { tiempoRelativo, gaNum } from "@/lib/utils"
import { useAuthStore } from "@/store/auth"
import AprendicesPanel from "@/components/AprendicesPanel"

interface EvidenciaActiva {
  id: string
  nombre: string
  href: string
  tipo: string          // "assign" | "forum" | "quiz" | ...
  pendientes: number
  calificados: number
  sinEntregar: number
  total: number
  ultimoScan: string | null
  calificandoAt: string | null
}

interface FichaActiva {
  id: string
  codigo: string
  nombre: string
  evidencias: EvidenciaActiva[]
}

interface ScanStatus {
  lastAutoScanAt: string | null
  nextAutoScanAt: string | null
  activeCount: number
}

interface ScanProgress {
  active: number
  waiting: number
  completed: number
  failed: number
}


function PendientesBadge({ ev }: { ev: EvidenciaActiva }) {
  if (ev.calificandoAt) return <Badge variant="yellow" className="text-xs">Calificando</Badge>
  if (ev.total === 0)   return <Badge variant="gray"   className="text-xs">Sin escanear</Badge>
  if (ev.pendientes === 0) return <Badge variant="green" className="text-xs">Al día</Badge>
  return <Badge variant="yellow" className="text-xs">{ev.pendientes} pendiente{ev.pendientes !== 1 ? "s" : ""}</Badge>
}

export default function Dashboard() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()
  const [expandedEv, setExpandedEv]           = useState<string | null>(null)
  const [collapsedFichas, setCollapsedFichas] = useState<Record<string, boolean>>({})
  const [selectedFichaId, setSelectedFichaId] = useState<string>("ALL")
  // fichas start collapsed; undefined means not yet toggled → treat as collapsed
  const [scanStatus, setScanStatus]           = useState("")
  const [scanLoading, setScanLoading]         = useState(false)

  function toggleFicha(fichaId: string) {
    setCollapsedFichas(c => ({ ...c, [fichaId]: !(c[fichaId] ?? true) }))
  }

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

  const { data, isLoading, error } = useQuery<{ fichas: FichaActiva[] }>({
    queryKey: ["evidencias-activas"],
    queryFn:  () => apiFetch<{ fichas: FichaActiva[] }>("/api/evidencias/activas"),
    enabled:  !!jwt,
    retry:    false,
  })

  if (error instanceof ApiError && error.status === 401) {
    clearAuth(); navigate("/login")
  }

  const { data: scanStatus_ } = useQuery<ScanStatus>({
    queryKey: ["scan-status"],
    queryFn:  () => apiFetch("/api/scan/status"),
    enabled:  !!jwt,
    refetchInterval: 60_000,
  })

  const { data: scanProgress } = useQuery<ScanProgress>({
    queryKey: ["scan-progress"],
    queryFn:  () => apiFetch("/api/scan/progress"),
    enabled:  !!jwt,
    refetchInterval: (query) => {
      const p = query.state.data as ScanProgress | undefined
      if (scanLoading) return 3000
      if (p && (p.active + p.waiting) > 0) return 3000
      return 15000 // Poll slower when idle
    }
  })

  const isScanning = scanLoading || (scanProgress && (scanProgress.active + scanProgress.waiting) > 0)

  // Gatillo silencioso: si pasaron >2 horas o nunca se ha escaneado, y hay activas
  const hasTriggeredAutoScan = useRef(false)
  useEffect(() => {
    if (scanStatus_ && scanStatus_.activeCount > 0 && !hasTriggeredAutoScan.current) {
      const last = scanStatus_.lastAutoScanAt ? new Date(scanStatus_.lastAutoScanAt).getTime() : 0
      const hoursSinceLast = (Date.now() - last) / (1000 * 60 * 60)
      if (hoursSinceLast >= 2) {
        hasTriggeredAutoScan.current = true
        apiFetch("/api/scan/auto", { method: "POST" })
          .then(() => queryClient.invalidateQueries({ queryKey: ["scan-status"] }))
          .catch(console.error)
      }
    }
  }, [scanStatus_, queryClient])

  const calificandoMutation = useMutation({
    mutationFn: ({ id, calificando }: { id: string; calificando: boolean }) =>
      apiFetch(`/api/evidencias/${encodeURIComponent(id)}/estado`, {
        method: "PATCH",
        body:   JSON.stringify({ calificando }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["evidencias-activas"] }),
  })

  async function handleRefrescar() {
    setScanLoading(true)
    setScanStatus("Iniciando scan...")
    try {
      await apiFetch("/api/scan/full", { method: "POST" })
      setScanStatus("Scan iniciado. Los datos se actualizarán en breve.")
      queryClient.invalidateQueries({ queryKey: ["scan-status"] })
      queryClient.invalidateQueries({ queryKey: ["scan-progress"] })
    } catch (err) {
      setScanStatus(err instanceof ApiError ? err.message : "Error al iniciar scan.")
      setScanLoading(false)
    }
    // We do NOT set scanLoading=false here on success. We let the polling update `isScanning` 
    // and when `active + waiting === 0`, it will naturally stop showing the bar.
    // Actually, we should set scanLoading=false after a few seconds or rely on `isScanning` from progress.
    setTimeout(() => setScanLoading(false), 4000)
  }

  function handleCalificar(ev: EvidenciaActiva, actId: string | null) {
    calificandoMutation.mutate({ id: ev.id, calificando: true })
    if (actId) {
      window.open(`https://zajuna.sena.edu.co/zajuna/mod/assign/view.php?id=${actId}&action=grading`, "_blank")
    }
  }

  const fichas: FichaActiva[] = data?.fichas ?? []
  const totalPendientes = fichas.flatMap((f: FichaActiva) => f.evidencias).reduce((s: number, ev: EvidenciaActiva) => s + ev.pendientes, 0)

  return (
    <Layout>
      <div className="space-y-4">
        {/* Status bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1">
            {isScanning && scanProgress ? (
              <div className="flex flex-col gap-1.5 w-full max-w-md">
                <div className="flex justify-between text-xs text-gray-600 font-medium">
                  <span>Escaneando en segundo plano...</span>
                  <span>{scanProgress.active + scanProgress.waiting} restantes</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-blue-600 h-full rounded-full transition-all duration-500 ease-out" 
                    style={{ 
                      width: `${(scanProgress.completed + scanProgress.failed + scanProgress.active + scanProgress.waiting) === 0 ? 0 : 
                        ((scanProgress.completed + scanProgress.failed) / (scanProgress.completed + scanProgress.failed + scanProgress.active + scanProgress.waiting)) * 100}%` 
                    }}
                  />
                </div>
                <p className="text-xs text-gray-400">Esto puede demorar.</p>
              </div>
            ) : scanStatus_?.lastAutoScanAt ? (
              <span className="text-sm text-gray-600">
                Actualizado {tiempoRelativo(scanStatus_?.lastAutoScanAt)}
                {scanStatus_?.nextAutoScanAt && ` · próximo scan ${tiempoRelativo(scanStatus_?.nextAutoScanAt)}`}
              </span>
            ) : (
              <span className="text-sm text-gray-400">Auto-scan no configurado aún</span>
            )}
          </div>
          {scanStatus && !isScanning && <span className="text-sm text-blue-600">{scanStatus}</span>}
          <Button variant="outline" size="sm" onClick={handleRefrescar} disabled={!!isScanning} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? "animate-spin" : ""}`} />
            Refrescar ahora
          </Button>
        </div>

        {/* Resumen */}
        {fichas.length > 0 && (
          <div className="flex items-center gap-3 px-1">
            <span className="text-sm text-gray-600">
              {scanStatus_?.activeCount ?? 0} evidencias activas
            </span>
            {totalPendientes > 0 && (
              <Badge variant="yellow">{totalPendientes} pendiente{totalPendientes !== 1 ? "s" : ""} en total</Badge>
            )}
          </div>
        )}

        {/* Filtro de Fichas */}
        {fichas.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
            <Button 
              variant={selectedFichaId === "ALL" ? "default" : "outline"} 
              size="sm" 
              onClick={() => setSelectedFichaId("ALL")}
              className="whitespace-nowrap h-8 text-xs bg-white text-gray-700 border-gray-200 shadow-sm data-[active=true]:bg-sena-green data-[active=true]:text-white data-[active=true]:border-sena-green"
              data-active={selectedFichaId === "ALL"}
            >
              Todas las fichas
            </Button>
            {fichas.map(f => (
              <Button 
                key={f.id}
                variant={selectedFichaId === f.id ? "default" : "outline"} 
                size="sm" 
                onClick={() => setSelectedFichaId(f.id)}
                className="whitespace-nowrap h-8 text-xs bg-white text-gray-700 border-gray-200 shadow-sm data-[active=true]:bg-sena-green data-[active=true]:text-white data-[active=true]:border-sena-green"
                data-active={selectedFichaId === f.id}
              >
                Ficha {f.codigo}
              </Button>
            ))}
          </div>
        )}

        {/* Lista de evidencias */}
        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">Cargando...</div>
        ) : fichas.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-gray-600 text-sm mb-2">No hay evidencias activas.</p>
            <p className="text-gray-400 text-xs">
              Ve a <strong>Mis Evidencias</strong> para seleccionar cuáles quieres rastrear.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {(selectedFichaId === "ALL" ? fichas : fichas.filter(f => f.id === selectedFichaId)).map(f => {
              const evOrdenadas  = [...f.evidencias].sort((a, b) => gaNum(a.nombre) - gaNum(b.nombre) || a.nombre.localeCompare(b.nombre))
              const isCollapsed  = collapsedFichas[f.id] ?? true
              const pendFicha    = f.evidencias.reduce((s, ev) => s + ev.pendientes, 0)
              return (
                <div key={f.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {/* Header ficha — clickable para colapsar */}
                  <div
                    className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center gap-2 cursor-pointer select-none hover:bg-gray-100 transition-colors"
                    onClick={() => toggleFicha(f.id)}
                  >
                    {isCollapsed
                      ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      : <ChevronDown  className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
                    <span className="font-mono text-xs font-semibold text-gray-700">{f.codigo}</span>
                    {f.nombre && <span className="text-xs text-gray-500 truncate flex-1">{f.nombre}</span>}
                    <span className="text-xs text-gray-400 flex-shrink-0">{evOrdenadas.length} ev.</span>
                    {pendFicha > 0 && <Badge variant="yellow" className="text-xs flex-shrink-0">{pendFicha} pend.</Badge>}
                  </div>

                  {!isCollapsed && <div className="divide-y divide-gray-50">
                    {evOrdenadas.map(ev => {
                      const actIdMatch = ev.href.match(/[?&]id=(\d+)/)
                      const actId = actIdMatch ? actIdMatch[1] : null
                      const isExpanded = expandedEv === ev.id

                      return (
                        <div key={ev.id}>
                          <div className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 flex-wrap sm:flex-nowrap">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800 truncate" title={ev.nombre}>{ev.nombre}</p>
                              <p className="text-xs text-gray-400 mt-0.5">{tiempoRelativo(ev.ultimoScan)}</p>
                            </div>

                            <PendientesBadge ev={ev} />

                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => setExpandedEv(isExpanded ? null : ev.id)}
                              >
                                {isExpanded ? "Ocultar" : "Ver aprendices"}
                              </Button>

                              {/* FORO: píldora conversacional → redirige al foro en Moodle */}
                              {ev.tipo === "forum" && ev.pendientes > 0 && (
                                <a
                                  href={ev.href}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Ir al foro en la plataforma para calificar manualmente"
                                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors whitespace-nowrap"
                                >
                                  💬 {ev.pendientes} comentario{ev.pendientes !== 1 ? "s" : ""} sin calificar
                                </a>
                              )}

                              {/* NO-FORO: botón Calificar normal */}
                              {ev.tipo !== "forum" && ev.pendientes > 0 && (
                                <Button
                                  size="sm"
                                  className="h-7 text-xs px-2 bg-sena-green hover:bg-sena-green/90"
                                  onClick={() => handleCalificar(ev, actId)}
                                >
                                  Calificar
                                </Button>
                              )}

                              {ev.calificandoAt && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs px-2.5 text-gray-600 border-gray-300 hover:bg-gray-100 flex items-center gap-1.5"
                                  onClick={() => calificandoMutation.mutate({ id: ev.id, calificando: false })}
                                  title="Forzar estado a 'Al día' si ya terminaste de calificar en la plataforma y quedan pendientes"
                                >
                                  <span>Forzar Al día</span>
                                  <span className="text-gray-400 font-bold">✕</span>
                                </Button>
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="px-4 pb-3">
                              <AprendicesPanel evidenciaId={ev.id} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Layout>
  )
}
