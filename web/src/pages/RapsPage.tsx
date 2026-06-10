import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown, ChevronRight, Link2, Unlink,
  Search, X, Loader2, BookOpen, RefreshCw,
} from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { apiFetch, ApiError } from "@/api/client"
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Criterio {
  id?:         string
  descripcion: string
  orden:       number
}

interface RapSummary {
  id:              string
  codigo:          string
  descripcion:     string
  criteriosCount:  number
  evidenciasCount: number
  criterios:       Criterio[]
}

interface FichaInfo {
  id:     string
  codigo: string
  nombre: string
}

interface EvidenciaAsociada {
  relId:  string
  id:     string
  nombre: string
  tipo:   string
  href?:  string
  ficha:  FichaInfo
}

interface RapDetalle extends RapSummary {
  evidencias: EvidenciaAsociada[]
}

interface EvidenciaTodas {
  id:     string
  nombre: string
  tipo:   string
}

interface FichaConEvidencias {
  id:        string
  codigo:    string
  nombre:    string
  evidencias: EvidenciaTodas[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tipoBadgeVariant(tipo: string): "blue" | "purple" | "yellow" | "gray" {
  const map: Record<string, "blue" | "purple" | "yellow" | "gray"> = {
    assign: "blue", forum: "purple", quiz: "yellow",
  }
  return map[tipo] ?? "gray"
}

function tipoBadgeLabel(tipo: string): string {
  const map: Record<string, string> = { assign: "Tarea", forum: "Foro", quiz: "Quiz" }
  return map[tipo] ?? tipo
}

// ─── Sub-componente: panel de detalle de un RAP ───────────────────────────────

function RapDetailPanel({ rapId }: { rapId: string }) {
  const queryClient = useQueryClient()
  const [evSearch, setEvSearch] = useState("")

  const { data: detalle, isLoading } = useQuery<RapDetalle>({
    queryKey: ["rap-detalle", rapId],
    queryFn:  () => apiFetch<RapDetalle>(`/api/raps/${encodeURIComponent(rapId)}`),
    staleTime: 30_000,
  })

  const { data: todasData } = useQuery<{ fichas: FichaConEvidencias[] }>({
    queryKey: ["evidencias-todas"],
    queryFn:  () => apiFetch<{ fichas: FichaConEvidencias[] }>("/api/evidencias/todas"),
    staleTime: 60_000,
  })

  const asociarMutation = useMutation({
    mutationFn: (evidenciaId: string) =>
      apiFetch(`/api/raps/${encodeURIComponent(rapId)}/evidencias/${encodeURIComponent(evidenciaId)}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rap-detalle", rapId] })
      queryClient.invalidateQueries({ queryKey: ["raps"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al asociar la evidencia."),
  })

  const desasociarMutation = useMutation({
    mutationFn: (evidenciaId: string) =>
      apiFetch(`/api/raps/${encodeURIComponent(rapId)}/evidencias/${encodeURIComponent(evidenciaId)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rap-detalle", rapId] })
      queryClient.invalidateQueries({ queryKey: ["raps"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al quitar la asociación."),
  })

  const todasEvidencias = (todasData?.fichas ?? []).flatMap(f =>
    f.evidencias.map(ev => ({ ...ev, ficha: { id: f.id, codigo: f.codigo, nombre: f.nombre } }))
  )

  const asociadasIds = new Set((detalle?.evidencias ?? []).map(e => e.id))

  const disponibles = todasEvidencias
    .filter(ev => !asociadasIds.has(ev.id))
    .filter(ev => {
      if (!evSearch.trim()) return false
      return ev.nombre.toLowerCase().includes(evSearch.toLowerCase())
    })
    .slice(0, 10)

  if (isLoading) {
    return (
      <div className="px-5 py-6 flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Cargando detalle...
      </div>
    )
  }

  if (!detalle) return null

  return (
    <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-4 space-y-4">
      {/* Criterios */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Criterios de evaluación ({detalle.criterios.length})
        </h4>
        {detalle.criterios.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Sin criterios definidos.</p>
        ) : (
          <ol className="space-y-1 list-none">
            {detalle.criterios.map((c, i) => (
              <li key={c.id ?? i} className="flex gap-2 text-sm text-gray-700">
                <span className="text-xs text-gray-400 mt-0.5 flex-shrink-0 w-5 text-right">{i + 1}.</span>
                <span>{c.descripcion}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Evidencias asociadas */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Evidencias asociadas ({detalle.evidencias.length})
        </h4>
        {detalle.evidencias.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {detalle.evidencias.map(ev => (
              <div key={ev.relId} className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                <Badge variant={tipoBadgeVariant(ev.tipo)} className="text-xs flex-shrink-0">
                  {tipoBadgeLabel(ev.tipo)}
                </Badge>
                <span className="text-xs font-mono text-gray-500 flex-shrink-0">{ev.ficha.codigo}</span>
                <span className="text-sm text-gray-700 flex-1 truncate">{ev.nombre}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-gray-400 hover:text-red-500 flex-shrink-0"
                  title="Quitar asociación"
                  disabled={desasociarMutation.isPending}
                  onClick={() => {
                    if (!confirm("¿Quitar esta evidencia del RAP?")) return
                    desasociarMutation.mutate(ev.id)
                  }}
                >
                  <Unlink className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Buscador para agregar evidencias */}
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
            <Input
              value={evSearch}
              onChange={e => setEvSearch(e.target.value)}
              placeholder="Buscar evidencia para asociar..."
              className="h-8 text-sm pl-8"
            />
            {evSearch && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                onClick={() => setEvSearch("")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {evSearch.trim() && disponibles.length === 0 && (
            <p className="text-xs text-gray-400 px-1">No hay evidencias disponibles con ese nombre.</p>
          )}

          {disponibles.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {disponibles.map(ev => (
                <div
                  key={ev.id}
                  className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5 hover:border-sena-green/50 hover:bg-sena-green/5 transition-colors"
                >
                  <Badge variant={tipoBadgeVariant(ev.tipo)} className="text-xs flex-shrink-0">
                    {tipoBadgeLabel(ev.tipo)}
                  </Badge>
                  <span className="text-xs font-mono text-gray-500 flex-shrink-0">
                    {(ev as typeof ev & { ficha: FichaInfo }).ficha.codigo}
                  </span>
                  <span className="text-sm text-gray-700 flex-1 truncate">{ev.nombre}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-gray-400 hover:text-sena-green flex-shrink-0"
                    title="Asociar evidencia"
                    disabled={asociarMutation.isPending}
                    onClick={() => { asociarMutation.mutate(ev.id); setEvSearch("") }}
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function RapsPage() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id:                payload.id || "",
          nombre:            payload.nombre || "",
          email:             payload.email || "",
          competenciaNombre: payload.competenciaNombre || "",
          competenciaCodigo: payload.competenciaCodigo || "",
        })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { data: raps, isLoading, isFetching, refetch } = useQuery<RapSummary[]>({
    queryKey: ["raps"],
    queryFn:  () => apiFetch<RapSummary[]>("/api/raps"),
    enabled:  !!jwt,
    retry:    false,
  })

  function toggleExpand(rapId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(rapId)) next.delete(rapId)
      else next.add(rapId)
      return next
    })
  }

  const rapsList = raps ?? []

  return (
    <Layout>
      <div className="space-y-4">

        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <BookOpen className="w-4 h-4 text-sena-green" />
            <div>
              <h1 className="text-sm font-semibold text-gray-900">Resultados de Aprendizaje (RAPs)</h1>
              {user?.competenciaNombre
                ? <p className="text-xs text-gray-500 truncate">{user.competenciaNombre} · {user.competenciaCodigo}</p>
                : <p className="text-xs text-gray-400">Tu competencia</p>
              }
            </div>
          </div>
          {rapsList.length > 0 && (
            <Badge variant="gray" className="text-xs">{rapsList.length} RAP{rapsList.length !== 1 ? "s" : ""}</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => refetch().then(() => toast.success("RAPs actualizados"))}
            disabled={isFetching}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </Button>
        </div>

        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Cargando RAPs...
          </div>
        ) : rapsList.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center space-y-3">
            <BookOpen className="w-10 h-10 text-gray-300 mx-auto" />
            <p className="text-gray-600 text-sm font-medium">No hay RAPs para tu competencia.</p>
            <p className="text-gray-400 text-xs">Contacta al administrador para cargar los RAPs de tu programa.</p>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs mx-auto" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Reintentar
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {rapsList.map(rap => {
              const isExpanded = expanded.has(rap.id)
              return (
                <div key={rap.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div
                    className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-50 select-none"
                    onClick={() => toggleExpand(rap.id)}
                  >
                    {isExpanded
                      ? <ChevronDown  className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                      : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-bold text-gray-900">{rap.codigo}</span>
                        <Badge variant="gray" className="text-xs">
                          {rap.criteriosCount} criterio{rap.criteriosCount !== 1 ? "s" : ""}
                        </Badge>
                        {rap.evidenciasCount > 0 && (
                          <Badge variant="green" className="text-xs">
                            {rap.evidenciasCount} evidencia{rap.evidenciasCount !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">{rap.descripcion}</p>
                    </div>
                  </div>

                  {isExpanded && <RapDetailPanel rapId={rap.id} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

    </Layout>
  )
}
