import { useState, useRef, useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Save, RefreshCw } from "lucide-react"
import { apiFetch, authFetch, ApiError } from "@/api/client"

type EstadoFiltro = "" | "pendiente" | "calificado" | "sin_entregar"

interface Aprendiz {
  id: string
  nombre: string
  moodleId: string | null
}

interface Entrega {
  id: string
  // El union de `estado` sigue CERRADO a los 3 valores de negocio: el subestado
  // fino (borrador) viaja aparte en `subestado`, NO infla este tipo (plan 009).
  estado: "pendiente" | "calificado" | "sin_entregar"
  fechaScan: string
  moodlePostId: string | null
  notaActual: number | null
  // Nota cualitativa SENA (A=Aprobado / D=Deficiente) — muchos cursos califican
  // con letra y notaActual queda null (ver Entrega.notaCualitativa en schema.prisma).
  notaCualitativa: string | null
  // Subestado crudo de Moodle (submissionstatus): "draft"/"reopened"/etc.
  // Solo presentación: la UI pinta un badge "Borrador" cuando ="draft". No
  // afecta `estado` ni el acta. Puede venir null (foros/quiz, scans viejos).
  subestado?: string | null
  aprendiz: Aprendiz
}

interface EntregasResponse {
  evidenciaId: string
  evidenciaNombre: string
  actId: string | null
  tipo: string | null
  entregas: Entrega[]
}

const ZAJUNA_BASE = "https://zajuna.sena.edu.co/zajuna"

function estadoLabel(estado: string): string {
  if (estado === "pendiente") return "Pendiente"
  if (estado === "calificado") return "Calificado"
  return "Sin entregar"
}

function estadoVariant(estado: string): "yellow" | "green" | "gray" {
  if (estado === "pendiente") return "yellow"
  if (estado === "calificado") return "green"
  return "gray"
}

// Nota NUMÉRICA a mostrar junto al estado ("Calificado · 100"). La cualitativa
// (A/D) ya NO se mezcla aquí: se pinta como badge aparte (ver más abajo) para
// que convivan número y letra cuando existen ambos. Devuelve null si no hay nota
// numérica.
function notaVisible(e: Entrega): string | null {
  if (e.notaActual != null) {
    // Redondeo a 1 decimal para floats tipo 66.66667; enteros sin decimales.
    return Number.isInteger(e.notaActual)
      ? String(e.notaActual)
      : String(Math.round(e.notaActual * 10) / 10)
  }
  return null
}

// Reprobada = numérica < 70 (umbral SENA universal, regla #10 de CLAUDE.md) o
// cualitativa sin señal explícita de aprobación (A / "aprobad", regla #11).
function esNotaReprobada(e: Entrega): boolean {
  if (e.notaActual != null) return e.notaActual < 70
  if (e.notaCualitativa) return !cualitativaAprobada(e.notaCualitativa)
  return false
}

// Aprobada cualitativa = "A" exacta o texto con "aprobad" (regla #11 de CLAUDE.md).
// Cualquier otra letra (típicamente "D" = Deficiente) cuenta como NO aprobada.
function cualitativaAprobada(c: string): boolean {
  const t = c.trim()
  return /^a$/i.test(t) || /aprobad/i.test(t)
}

export default function AprendicesPanel({ evidenciaId }: { evidenciaId: string }) {
  const queryClient = useQueryClient()
  const [filtro, setFiltro] = useState<EstadoFiltro>("")
  // Sprint 2.5 FIX 4: calificaciones pendientes de envio para foros (key=moodleId)
  const [ratings, setRatings] = useState<Record<string, string>>({})
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "error" | "success">("idle")
  const [saveMsg, setSaveMsg]     = useState("")
  // Sprint 2.9: cuando guardamos UNA sola calificacion (boton individual),
  // marcamos aqui el moodleId para mostrar spinner solo en esa fila.
  const [savingSingle, setSavingSingle] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Verificación en vivo contra Moodle: lista de moodleUserIds que en Moodle
  // tienen posts publicados pero sin rating del instructor.
  const [pendientesMoodle, setPendientesMoodle] = useState<Set<string> | null>(null)
  const [discoverPhase, setDiscoverPhase] = useState<"idle" | "running" | "error" | "success">("idle")
  const [discoverMsg, setDiscoverMsg]     = useState("")
  const discoverPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  function stopDiscoverPoll() {
    if (discoverPollRef.current) { clearInterval(discoverPollRef.current); discoverPollRef.current = null }
  }
  useEffect(() => () => stopDiscoverPoll(), [])

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }
  useEffect(() => () => stopPoll(), [])

  const { data, isLoading, error } = useQuery<EntregasResponse>({
    queryKey: ["entregas", evidenciaId],
    queryFn: () =>
      apiFetch<EntregasResponse>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/entregas`
      ),
    staleTime: 2 * 60 * 1000,
  })

  // NOTA (plan 009): la calificación de foros DESDE LA APP se retiró de la UI
  // (los inputs de nota y los botones de guardar ya no se renderizan para foros).
  // Estas funciones y el endpoint PATCH .../foro/calificar se CONSERVAN a propósito
  // —no se borran— para no perder el flujo (es reversible y el backend sigue vivo);
  // simplemente ya nada las invoca desde el render de foros.
  async function guardarCalificacionIndividual(moodleId: string, nota: string) {
    const notaNum = Number(nota)
    if (!nota || Number.isNaN(notaNum)) return
    setSavingSingle(moodleId)
    setSavePhase("saving")
    setSaveMsg("Guardando...")
    stopPoll()
    try {
      const { jobId } = await apiFetch<{ jobId: string }>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/foro/calificar`,
        { method: "PATCH", body: JSON.stringify({ ratings: [{ moodleUserId: moodleId, nota: notaNum }] }) }
      )
      pollRef.current = setInterval(async () => {
        try {
          const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
          const d = await res.json()
          if (!res.ok) { stopPoll(); setSavingSingle(null); setSavePhase("error"); setSaveMsg(d?.errorMsg || `Error ${res.status}`); return }
          if (d.status === "done") {
            stopPoll(); setSavingSingle(null)
            const r = d.resultado as { total: number; ok: number; results: Array<{ ok: boolean; error?: string; moodleUserId: string }> }
            const item = r.results.find(x => String(x.moodleUserId) === moodleId)
            if (item?.ok) {
              setSavePhase("success")
              setSaveMsg("Calificación guardada.")
              setRatings(p => { const n = {...p}; delete n[moodleId]; return n })
              queryClient.invalidateQueries({ queryKey: ["entregas", evidenciaId] })
              queryClient.invalidateQueries({ queryKey: ["evidencias"] })
            } else {
              setSavePhase("error")
              setSaveMsg(item?.error || "Error al calificar.")
            }
          } else if (d.status === "error") {
            stopPoll(); setSavingSingle(null)
            setSavePhase("error"); setSaveMsg(d.errorMsg || "El job falló.")
          } else {
            setSaveMsg(`Guardando... ${d.progreso || 0}%`)
          }
        } catch (err) {
          stopPoll(); setSavingSingle(null)
          setSavePhase("error")
          setSaveMsg(err instanceof Error ? err.message : "Error de red.")
        }
      }, 2500)
    } catch (e) {
      setSavingSingle(null); setSavePhase("error")
      setSaveMsg(e instanceof ApiError ? e.message : "Error al iniciar el guardado.")
    }
  }

  async function verificarPendientesEnMoodle() {
    setDiscoverPhase("running")
    setDiscoverMsg("Conectando con Moodle...")
    setPendientesMoodle(null)
    stopDiscoverPoll()
    try {
      const { jobId } = await apiFetch<{ jobId: string }>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/foro/descubrir-pendientes`,
        { method: "POST" }
      )
      discoverPollRef.current = setInterval(async () => {
        try {
          const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
          const d = await res.json()
          if (!res.ok) {
            stopDiscoverPoll()
            setDiscoverPhase("error")
            setDiscoverMsg(d?.errorMsg || `Error ${res.status}`)
            return
          }
          if (d.status === "done") {
            stopDiscoverPoll()
            const r = d.resultado as {
              pendientes: Array<{ moodleUserId: string }>
              calificados: Array<{ moodleUserId: string }>
              totalPosts: number
            }
            const ids = new Set(r.pendientes.map(p => String(p.moodleUserId)))
            setPendientesMoodle(ids)
            setDiscoverPhase("success")
            setDiscoverMsg(`${ids.size} sin calificar / ${r.calificados.length} calificados en Moodle (${r.totalPosts} posts)`)
          } else if (d.status === "error") {
            stopDiscoverPoll()
            setDiscoverPhase("error")
            setDiscoverMsg(d.errorMsg || "El job fallo.")
          } else {
            setDiscoverMsg(`Verificando... ${d.progreso || 0}%`)
          }
        } catch (err) {
          stopDiscoverPoll()
          setDiscoverPhase("error")
          setDiscoverMsg(err instanceof Error ? err.message : "Error de red.")
        }
      }, 2500)
    } catch (e) {
      setDiscoverPhase("error")
      setDiscoverMsg(e instanceof ApiError ? e.message : "Error al iniciar verificación.")
    }
  }

  async function guardarCalificaciones() {
    const items = Object.entries(ratings)
      .filter(([, v]) => v !== "" && v != null)
      .map(([moodleUserId, nota]) => ({ moodleUserId, nota: Number(nota) }))
      .filter((r) => !Number.isNaN(r.nota))

    if (items.length === 0) {
      setSaveMsg("No hay calificaciones para enviar.")
      setSavePhase("error")
      return
    }

    setSavePhase("saving")
    setSaveMsg(`Enviando ${items.length} calificacion${items.length !== 1 ? "es" : ""}...`)
    try {
      const { jobId } = await apiFetch<{ jobId: string }>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/foro/calificar`,
        { method: "PATCH", body: JSON.stringify({ ratings: items }) }
      )
      stopPoll()
      pollRef.current = setInterval(async () => {
        try {
          const res  = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
          const d = await res.json()
          if (!res.ok) { stopPoll(); setSavePhase("error"); setSaveMsg(d?.errorMsg || `Error ${res.status}`); return }
          if (d.status === "done") {
            stopPoll()
            const r = d.resultado as { total: number; ok: number; results: Array<{ ok: boolean; error?: string; moodleUserId: string }> }
            const fail = r.results.filter((x) => !x.ok)
            if (fail.length === 0) {
              setSavePhase("success")
              setSaveMsg(`${r.ok}/${r.total} calificaciones guardadas.`)
              setRatings({})
            } else {
              setSavePhase("error")
              setSaveMsg(`${r.ok}/${r.total} ok. Errores: ${fail.slice(0,3).map((f) => `${f.moodleUserId}: ${f.error}`).join(" | ")}`)
            }
            queryClient.invalidateQueries({ queryKey: ["entregas", evidenciaId] })
            queryClient.invalidateQueries({ queryKey: ["evidencias"] })
          } else if (d.status === "error") {
            stopPoll()
            setSavePhase("error"); setSaveMsg(d.errorMsg || "El job fallo.")
          } else {
            setSaveMsg(`Guardando... ${d.progreso || 0}%`)
          }
        } catch (err) {
          stopPoll()
          setSavePhase("error")
          setSaveMsg(err instanceof Error ? err.message : "Error de red.")
        }
      }, 2500)
    } catch (e) {
      setSavePhase("error")
      setSaveMsg(e instanceof ApiError ? e.message : "Error al iniciar el guardado.")
    }
  }

  if (isLoading) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-gray-500">Cargando aprendices...</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-red-500">Error al cargar aprendices.</p>
      </div>
    )
  }

  const { entregas, actId, tipo } = data
  const esForo = tipo === "forum"

  // Foros (plan 009): ya NO se califica desde la app (el instructor igual debe
  // entrar a Moodle a leer los aportes). Aquí solo señalamos si el aprendiz tiene
  // comentarios "Pendiente de revisar" o ya "Revisado". Prioriza la verificación
  // en vivo (pendientesMoodle) si el instructor la corrió; si no, cae al estado
  // del último scan ("pendiente" = hay post sin rating en Moodle). sin_entregar =
  // no participó → no hay nada que revisar (null, no se pinta etiqueta).
  function revisionForo(e: Entrega): "pendiente" | "revisado" | null {
    if (e.estado === "sin_entregar") return null
    const mid = e.aprendiz.moodleId
    if (pendientesMoodle && mid) {
      return pendientesMoodle.has(mid) ? "pendiente" : "revisado"
    }
    return e.estado === "pendiente" ? "pendiente" : "revisado"
  }

  if (entregas.length === 0) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-gray-500">Sin entregas registradas.</p>
      </div>
    )
  }

  const counts = {
    pendiente: entregas.filter((e) => e.estado === "pendiente").length,
    calificado: entregas.filter((e) => e.estado === "calificado").length,
    sin_entregar: entregas.filter((e) => e.estado === "sin_entregar").length,
  }

  const filtradas = filtro ? entregas.filter((e) => e.estado === filtro) : entregas

  const filters: { label: string; value: EstadoFiltro }[] = [
    { label: `Todos (${entregas.length})`, value: "" },
    { label: `Pendientes (${counts.pendiente})`, value: "pendiente" },
    { label: `Calificados (${counts.calificado})`, value: "calificado" },
    { label: `Sin entregar (${counts.sin_entregar})`, value: "sin_entregar" },
  ]

  return (
    <div className="border-t border-gray-100 bg-gray-50">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-1.5 px-6 pt-3 pb-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFiltro(f.value)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              filtro === f.value
                ? "bg-sena-green text-white border-sena-green"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Foros (plan 009): la calificación se hace en Moodle, no en la app. Esta
          barra ya NO califica — solo deja "Verificar en Moodle" para refrescar
          quién tiene comentarios sin revisar. Los inputs de nota por fila y el
          botón "Guardar calificaciones" se quitaron (el backend de calificación
          de foros sigue existiendo, solo dejamos de invocarlo desde aquí). */}
      {esForo && (
        <div className="px-6 pb-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 mr-auto">
            Las calificaciones de foro se gestionan en Moodle. Verifica quién tiene comentarios sin revisar.
          </span>
          {discoverPhase !== "idle" && (
            <span className={`text-xs ${
              discoverPhase === "error" ? "text-red-600" :
              discoverPhase === "success" ? "text-green-700" : "text-blue-600"
            }`}>
              {discoverMsg}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={verificarPendientesEnMoodle}
            disabled={discoverPhase === "running"}
            title="Verificar contra Moodle qué aprendices publicaron sin recibir nota"
          >
            {discoverPhase === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Verificar en Moodle
          </Button>
        </div>
      )}

      {/* List */}
      <div className="max-h-64 overflow-y-auto px-6 pb-3 space-y-0.5">
        {filtradas.length === 0 ? (
          <p className="text-xs text-gray-500 py-2">
            Ningún aprendiz con este filtro.
          </p>
        ) : (
          filtradas.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0"
            >
              {/* Para foros el nombre es texto plano (Abrir foro vive a la derecha y
                  llevaria al mismo URL). Para assigns el nombre va a action=grading
                  (tabla de busqueda) en cualquier estado. */}
              {actId && !esForo ? (
                <a
                  href={`${ZAJUNA_BASE}/mod/assign/view.php?id=${actId}&action=grading`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-sm text-gray-800 font-medium min-w-0 truncate hover:underline hover:text-sena-green"
                  title="Ver tabla de entregas"
                >
                  {e.aprendiz.nombre}
                </a>
              ) : (
                <span className="flex-1 text-sm text-gray-700 min-w-0 truncate">
                  {e.aprendiz.nombre}
                </span>
              )}
              <Badge variant={estadoVariant(e.estado)} className="text-xs shrink-0">
                {estadoLabel(e.estado)}
                {/* Nota NUMÉRICA junto al estado ("Calificado · 100"). En rojo si
                    reprobada (<70) para verla de un vistazo. La cualitativa A/D
                    va en su propio badge (abajo), no se mezcla aquí. */}
                {notaVisible(e) !== null && (
                  <span className={esNotaReprobada(e) ? "text-red-600 font-bold" : ""}>
                    {` · ${notaVisible(e)}`}
                  </span>
                )}
              </Badge>
              {/* Badge "Borrador" (plan 009): el aprendiz empezó la entrega pero NO
                  la envió (subestado="draft"). Es ADICIONAL al estado base (sigue
                  siendo "pendiente"); color ámbar para distinguirlo del amarillo
                  de "pendiente". Solo aplica a assigns (los foros no traen draft). */}
              {e.subestado === "draft" && (
                <Badge variant="orange" className="text-[10px] shrink-0" title="El aprendiz guardó un borrador pero aún no lo envió en Moodle">
                  Borrador
                </Badge>
              )}
              {/* Badge cualitativo A/D (plan 009 / PLAN_NOTA Fase 5): se captura en
                  DB pero antes no se pintaba cuando había nota numérica. Verde si
                  aprobada ("A"/"aprobad"), rojo si no (típicamente "D"). En foros
                  no se muestra: allí mandan las etiquetas de revisión de abajo. */}
              {!esForo && e.notaCualitativa && (
                <Badge variant={cualitativaAprobada(e.notaCualitativa) ? "green" : "destructive"} className="text-[10px] shrink-0" title="Nota cualitativa de la escala SENA (A=Aprobado / D=Deficiente)">
                  {e.notaCualitativa}
                </Badge>
              )}
              {/* Foros (plan 009): en vez de calificar, marcamos si el aporte está
                  "Pendiente de revisar" (hay comentario sin revisar) o "Revisado".
                  Reemplaza al antiguo badge "Sin nota en Moodle" + inputs de nota,
                  que ya se quitaron. Ver helper revisionForo(). */}
              {esForo && revisionForo(e) === "pendiente" && (
                <Badge variant="yellow" className="text-[10px] shrink-0" title="El aprendiz tiene comentarios sin revisar — entra a Moodle a leerlos">
                  Pendiente de revisar
                </Badge>
              )}
              {esForo && revisionForo(e) === "revisado" && (
                <Badge variant="green" className="text-[10px] shrink-0" title="No hay comentarios sin revisar para este aprendiz">
                  Revisado
                </Badge>
              )}
              {actId && (esForo ? (
                <a
                  href={`${ZAJUNA_BASE}/mod/forum/view.php?id=${actId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs hover:underline shrink-0 font-medium text-blue-500"
                  title="Abrir foro"
                >
                  Abrir foro
                </a>
              ) : e.aprendiz.moodleId ? (
                <a
                  href={`${ZAJUNA_BASE}/mod/assign/view.php?id=${actId}&action=grader&userid=${e.aprendiz.moodleId}&useridlistid=0`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`text-xs hover:underline shrink-0 font-medium ${
                    e.estado === "pendiente"
                      ? "text-sena-green"
                      : "text-blue-500"
                  }`}
                >
                  {e.estado === "pendiente" ? "Calificar" : "Ver entrega"}
                </a>
              ) : (
                // Sin moodleId en BD (scan viejo o selector que falló).
                // Tras el fix del selector (scraper/evidencias.js) refrescar la
                // ficha repobla este campo y desaparece este fallback.
                <a
                  href={`${ZAJUNA_BASE}/mod/assign/view.php?id=${actId}&action=grading`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs hover:underline shrink-0 font-medium text-gray-400 italic"
                  title="Sin ID Moodle en cache. Refresca esta ficha para repoblarlo."
                >
                  Sin ID · ir a tabla
                </a>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
