import { useState, useEffect, useRef } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Sparkles, ChevronDown, ChevronRight, CheckCircle, XCircle,
  AlertCircle, Loader2, Trash2, Clock, RotateCcw,
} from "lucide-react"
import Layout from "@/components/Layout"
import { Button }  from "@/components/ui/button"
import { Badge }   from "@/components/ui/badge"
import { apiFetch, authFetch, ApiError } from "@/api/client"
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

interface EvidenciaSnippet {
  id:     string
  nombre: string
  tipo:   string
}

interface RapSnippet {
  id:          string
  codigo:      string
  descripcion: string
}

interface Propuesta {
  id:          string
  evidenciaId: string
  rapId:       string
  confianza:   number
  razon:       string
  estado:      "propuesto" | "aprobado" | "rechazado"
  decidedAt:   string | null
  creadoAt:    string
  evidencia:   EvidenciaSnippet
  rap:         RapSnippet
}

type JobPhase = "idle" | "running" | "done" | "error"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tipoBadge(tipo: string) {
  const map: Record<string, string>                           = { assign: "Tarea", forum: "Foro", quiz: "Quiz" }
  const colors: Record<string, "blue" | "purple" | "yellow" | "gray"> = {
    assign: "blue", forum: "purple", quiz: "yellow",
  }
  return (
    <Badge variant={colors[tipo] ?? "gray"} className="text-xs flex-shrink-0">
      {map[tipo] ?? tipo}
    </Badge>
  )
}

function confianzaBadge(n: number) {
  const cls =
    n >= 80 ? "bg-green-100 text-green-800 border-green-200" :
    n >= 50 ? "bg-yellow-100 text-yellow-800 border-yellow-200" :
              "bg-red-100 text-red-800 border-red-200"
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {n}%
    </span>
  )
}

function estadoBadge(estado: string) {
  if (estado === "aprobado")  return <Badge variant="green"  className="text-xs">Aprobada</Badge>
  if (estado === "rechazado") return <Badge variant="destructive" className="text-xs">Rechazada</Badge>
  return null
}

// ─── Polling hook ─────────────────────────────────────────────────────────────

function usePollJob() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stop() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }

  function start(
    jobId:       string,
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function MatchingIaPage() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  // Job state
  const [phase,    setPhase]    = useState<JobPhase>("idle")
  const [progress, setProgress] = useState(0)
  const [jobMsg,   setJobMsg]   = useState("")

  // Historial collapse
  const [historialOpen, setHistorialOpen] = useState(false)

  // Summary after run
  const [lastResult, setLastResult] = useState<{ procesadas: number; errores: number } | null>(null)

  const poll = usePollJob()

  // ── Auth guard ──────────────────────────────────────────────────────────────
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

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: propuestasData, isLoading: loadingPropuestas } = useQuery<{ propuestas: Propuesta[] }>({
    queryKey: ["matching-propuestas"],
    queryFn:  () => apiFetch("/api/matching/propuestas"),
    enabled:  !!jwt,
    refetchInterval: phase === "done" ? 4000 : false,  // auto-refresh after job completes
  })

  const { data: historialData } = useQuery<{ propuestas: Propuesta[] }>({
    queryKey: ["matching-historial"],
    queryFn:  () => apiFetch("/api/matching/historial"),
    enabled:  !!jwt && historialOpen,
  })

  // ── Mutations ────────────────────────────────────────────────────────────────

  const decidirMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "aprobado" | "rechazado" }) =>
      apiFetch(`/api/matching/propuestas/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body:   JSON.stringify({ decision }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["matching-propuestas"] })
      queryClient.invalidateQueries({ queryKey: ["matching-historial"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al guardar la decisión."),
  })

  const eliminarMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/matching/propuestas/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["matching-propuestas"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al eliminar la propuesta."),
  })

  // ── Iniciar matching ─────────────────────────────────────────────────────────

  async function handleIniciar() {
    if (!confirm("Esto usará la IA de Claude para sugerir qué RAP evalúa cada evidencia.\n\n¿Continuar? (Se evaluarán TODAS tus evidencias)")) return

    setPhase("running")
    setProgress(5)
    setJobMsg("Iniciando análisis IA...")
    setLastResult(null)
    poll.stop()

    try {
      const resp = await apiFetch<{ jobId: string; total: number }>("/api/matching/iniciar", {
        method: "POST",
        body:   JSON.stringify({}),
      })

      setJobMsg(`Analizando ${resp.total} evidencia(s) con IA...`)

      poll.start(
        resp.jobId,
        (resultado) => {
          const r = resultado as { total: number; procesadas: number; errores: number }
          setPhase("done")
          setProgress(100)
          setJobMsg(`Completado: ${r.procesadas} sugerencias generadas, ${r.errores} errores.`)
          setLastResult({ procesadas: r.procesadas, errores: r.errores })
          queryClient.invalidateQueries({ queryKey: ["matching-propuestas"] })
          queryClient.invalidateQueries({ queryKey: ["matching-historial"] })
        },
        (msg) => {
          setPhase("error")
          setJobMsg(msg)
        },
        (p) => {
          setProgress(p)
          setJobMsg(`Analizando evidencias... ${p}%`)
        },
      )
    } catch (e) {
      setPhase("error")
      setJobMsg(e instanceof ApiError ? e.message : "Error al iniciar el matching.")
    }
  }

  function handleReset() {
    setPhase("idle")
    setProgress(0)
    setJobMsg("")
    setLastResult(null)
    poll.stop()
    queryClient.invalidateQueries({ queryKey: ["matching-propuestas"] })
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const propuestas = propuestasData?.propuestas ?? []
  const historial  = historialData?.propuestas  ?? []

  // Group propuestas by evidencia for display
  const grouped = propuestas.reduce<Record<string, { evidencia: EvidenciaSnippet; items: Propuesta[] }>>((acc, p) => {
    if (!acc[p.evidenciaId]) acc[p.evidenciaId] = { evidencia: p.evidencia, items: [] }
    acc[p.evidenciaId].items.push(p)
    return acc
  }, {})

  const aprobadas  = historial.filter(p => p.estado === "aprobado").length
  const rechazadas = historial.filter(p => p.estado === "rechazado").length

  const busy = phase === "running"

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Layout>
      <div className="space-y-6 pb-10">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-sena-green" />
                Matching IA — Evidencias ↔ RAPs
              </h1>
              <p className="text-sm text-gray-500 mt-1 max-w-2xl">
                La IA analiza cada evidencia y sugiere qué RAP (Resultado de Aprendizaje del Proceso)
                evalúa mejor. Revisa las sugerencias y aprueba o rechaza cada una.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {phase === "done" && (
                <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Nuevo análisis
                </Button>
              )}
              <Button
                size="sm"
                className="bg-sena-green hover:bg-sena-green/90 gap-2"
                onClick={handleIniciar}
                disabled={busy}
              >
                {busy
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Sparkles className="w-4 h-4" />
                }
                {busy ? "Analizando..." : "Sugerir matching con IA"}
              </Button>
            </div>
          </div>

          {/* Progress / status bar */}
          {phase !== "idle" && (
            <div className="mt-4 space-y-2">
              {phase === "running" && (
                <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-sena-green h-2 rounded-full transition-all duration-700"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
              <div className={`flex items-center gap-2 text-sm ${
                phase === "error" ? "text-red-700" :
                phase === "done"  ? "text-green-700" : "text-amber-700"
              }`}>
                {phase === "running" && <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />}
                {phase === "done"    && <CheckCircle className="w-4 h-4 flex-shrink-0" />}
                {phase === "error"   && <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                <span>{jobMsg}</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Propuestas pendientes ─────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3 uppercase tracking-wide">
            Propuestas pendientes
            {propuestas.length > 0 && (
              <span className="ml-2 bg-amber-100 text-amber-800 text-xs font-medium px-2 py-0.5 rounded-full normal-case">
                {propuestas.length}
              </span>
            )}
          </h2>

          {loadingPropuestas ? (
            <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Cargando propuestas...
            </div>
          ) : propuestas.length === 0 ? (
            <div className="bg-white rounded-lg border p-12 text-center">
              <Sparkles className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">
                No hay propuestas pendientes. Haz clic en "Sugerir matching con IA" para comenzar.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.values(grouped).map(({ evidencia, items }) => (
                <div key={evidencia.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {/* Evidencia header */}
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                    {tipoBadge(evidencia.tipo)}
                    <span className="text-sm font-medium text-gray-800 truncate">{evidencia.nombre}</span>
                  </div>

                  {/* Propuesta cards */}
                  <div className="divide-y divide-gray-50">
                    {items.map(p => (
                      <div key={p.id} className="px-4 py-3 flex flex-wrap items-start gap-3">
                        {/* RAP info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono font-semibold text-sena-green bg-sena-green/10 px-1.5 py-0.5 rounded">
                              {p.rap.codigo}
                            </span>
                            {confianzaBadge(p.confianza)}
                          </div>
                          <p className="text-sm text-gray-700 mt-1 leading-snug">
                            {p.rap.descripcion}
                          </p>
                          {p.razon && (
                            <p className="text-xs text-gray-400 mt-1 italic">"{p.razon}"</p>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 gap-1 text-xs text-green-700 border-green-200 hover:bg-green-50"
                            onClick={() => decidirMutation.mutate({ id: p.id, decision: "aprobado" })}
                            disabled={decidirMutation.isPending || eliminarMutation.isPending}
                            title="Aprobar — crea relación RAP ↔ Evidencia"
                          >
                            <CheckCircle className="w-3.5 h-3.5" />
                            Aprobar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 gap-1 text-xs text-red-700 border-red-200 hover:bg-red-50"
                            onClick={() => decidirMutation.mutate({ id: p.id, decision: "rechazado" })}
                            disabled={decidirMutation.isPending || eliminarMutation.isPending}
                            title="Rechazar sugerencia"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            Rechazar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-gray-400 hover:text-red-500"
                            onClick={() => eliminarMutation.mutate(p.id)}
                            disabled={decidirMutation.isPending || eliminarMutation.isPending}
                            title="Eliminar propuesta"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Summary after deciding ───────────────────────────────────── */}
        {(aprobadas > 0 || rechazadas > 0) && propuestas.length === 0 && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
            <p className="text-sm text-green-800">
              <strong>{aprobadas}</strong> sugerencia{aprobadas !== 1 ? "s" : ""} aprobada{aprobadas !== 1 ? "s" : ""} ·{" "}
              <strong>{rechazadas}</strong> rechazada{rechazadas !== 1 ? "s" : ""}. Todas las propuestas han sido revisadas.
            </p>
          </div>
        )}

        {/* ── Historial (collapsible) ───────────────────────────────────── */}
        <section>
          <button
            className="flex items-center gap-2 text-sm font-semibold text-gray-700 uppercase tracking-wide hover:text-gray-900 transition-colors"
            onClick={() => setHistorialOpen(o => !o)}
          >
            {historialOpen
              ? <ChevronDown  className="w-4 h-4" />
              : <ChevronRight className="w-4 h-4" />
            }
            Historial
            {(aprobadas > 0 || rechazadas > 0) && (
              <span className="ml-1 text-gray-400 font-normal normal-case">
                ({aprobadas} aprobadas, {rechazadas} rechazadas)
              </span>
            )}
          </button>

          {historialOpen && (
            <div className="mt-3">
              {historial.length === 0 ? (
                <div className="bg-white rounded-lg border p-8 text-center text-gray-400 text-sm">
                  No hay decisiones registradas aún.
                </div>
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-50 overflow-hidden">
                  {historial.map(p => (
                    <div key={p.id} className="px-4 py-3 flex flex-wrap items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          {tipoBadge(p.evidencia.tipo)}
                          <span className="text-sm text-gray-700 truncate">{p.evidencia.nombre}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono font-semibold text-sena-green bg-sena-green/10 px-1.5 py-0.5 rounded">
                            {p.rap.codigo}
                          </span>
                          {confianzaBadge(p.confianza)}
                          {estadoBadge(p.estado)}
                        </div>
                        <p className="text-xs text-gray-400 mt-1 italic">"{p.razon}"</p>
                      </div>
                      {p.decidedAt && (
                        <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0 mt-1">
                          <Clock className="w-3 h-3" />
                          {new Date(p.decidedAt).toLocaleDateString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

      </div>
    </Layout>
  )
}
