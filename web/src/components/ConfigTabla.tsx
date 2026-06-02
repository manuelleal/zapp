import { useState, useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch, ApiError } from "@/api/client"
import { usePollJob, pollJobOnce } from "@/hooks/usePollJob"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RefreshCw, Loader2, Search, X, CheckCircle, AlertCircle, Save, Square, CheckSquare } from "lucide-react"

// ─── Tipos ───────────────────────────────────────────────────────────────────
interface ConfigCache {
  tipo?:         string
  abrirFecha?:   string | null
  abrirHora?:    string | null
  entregaFecha?: string | null
  entregaHora?:  string | null
  limiteFecha?:  string | null
  limiteHora?:   string | null
  intentos?:     number | "Ilimitado" | null
}
interface FilaConfig {
  evidenciaId:   string
  nombre:        string
  tipo:          string
  actId:         string | null
  config:        ConfigCache | null
  configCacheAt: string | null
}
interface RowEdit {
  abrirFecha: string; abrirHora: string
  entregaFecha: string; entregaHora: string
  limiteFecha: string; limiteHora: string
  intentos: string  // "" | "-1" (Ilimitado) | "1".."N"
}
type RowState = { phase: "idle" | "saving" | "ok" | "error"; msg?: string }

// Qué campos soporta cada tipo (espejo de FIELD_MAPS en scraper/configEvidencias.js)
function soporta(tipo: string) {
  const t = (tipo || "").toLowerCase()
  return {
    apertura: true,                          // assign/forum/quiz: todos
    entrega:  true,
    limite:   t === "assign",                // solo assign
    intentos: t === "assign" || t === "quiz",
  }
}

function emptyEdit(): RowEdit {
  return { abrirFecha: "", abrirHora: "", entregaFecha: "", entregaHora: "", limiteFecha: "", limiteHora: "", intentos: "" }
}
function configToEdit(c: ConfigCache | null): RowEdit {
  if (!c) return emptyEdit()
  return {
    abrirFecha:   c.abrirFecha   ?? "",
    abrirHora:    c.abrirHora    ?? "",
    entregaFecha: c.entregaFecha ?? "",
    entregaHora:  c.entregaHora  ?? "",
    limiteFecha:  c.limiteFecha  ?? "",
    limiteHora:   c.limiteHora   ?? "",
    intentos:     c.intentos === "Ilimitado" ? "-1" : c.intentos != null ? String(c.intentos) : "",
  }
}

// ─── Componente ──────────────────────────────────────────────────────────────
export default function ConfigTabla({ fichaId }: { fichaId: string }) {
  const queryClient = useQueryClient()
  const [edits, setEdits]       = useState<Record<string, RowEdit>>({})
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch]     = useState("")
  const [loadPhase, setLoadPhase] = useState<"idle" | "loading" | "error">("idle")
  const [loadMsg, setLoadMsg]   = useState("")
  const pollLoad = usePollJob()

  const { data, isLoading } = useQuery<FilaConfig[]>({
    queryKey: ["ficha-config", fichaId],
    queryFn:  () => apiFetch<FilaConfig[]>(`/api/fichas/${encodeURIComponent(fichaId)}/config`),
    enabled:  !!fichaId,
  })

  // Re-sincroniza los inputs cuando llegan datos nuevos (carga o refetch).
  useEffect(() => {
    if (!data) return
    const next: Record<string, RowEdit> = {}
    for (const fila of data) next[fila.evidenciaId] = configToEdit(fila.config)
    setEdits(next)
  }, [data])

  const filas = useMemo(() => {
    const q = search.trim().toLowerCase()
    const arr = data ?? []
    return q ? arr.filter(f => f.nombre.toLowerCase().includes(q) || f.tipo.toLowerCase().includes(q)) : arr
  }, [data, search])

  function setField(id: string, key: keyof RowEdit, val: string) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [key]: val } }))
    setRowState(prev => ({ ...prev, [id]: { phase: "idle" } }))
  }

  function toggleSel(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleSelAll() {
    setSelected(prev => prev.size === filas.length ? new Set() : new Set(filas.map(f => f.evidenciaId)))
  }

  // ── Cargar/actualizar fechas de TODA la ficha (B1) ──────────────────────────
  async function cargarTodo() {
    setLoadPhase("loading"); setLoadMsg("Iniciando lectura...")
    try {
      const { jobId, total } = await apiFetch<{ jobId: string; total: number }>(
        `/api/fichas/${encodeURIComponent(fichaId)}/config/leer-todo`, { method: "POST" }
      )
      setLoadMsg(`Leyendo ${total} evidencias desde Moodle...`)
      pollLoad.start(
        jobId,
        () => { setLoadPhase("idle"); setLoadMsg(""); queryClient.invalidateQueries({ queryKey: ["ficha-config", fichaId] }) },
        (m) => { setLoadPhase("error"); setLoadMsg(m) },
        (p) => setLoadMsg(`Leyendo desde Moodle... ${p}%`),
      )
    } catch (e) {
      setLoadPhase("error")
      setLoadMsg(e instanceof ApiError ? e.message : "Error al iniciar la lectura.")
    }
  }

  // ── Validación de coherencia de fechas (apertura < entrega < límite) ────────
  function validar(e: RowEdit, tipo: string): string | null {
    const sop = soporta(tipo)
    const ap = e.abrirFecha   ? new Date(`${e.abrirFecha}T${e.abrirHora || "00:00"}`)   : null
    const en = e.entregaFecha ? new Date(`${e.entregaFecha}T${e.entregaHora || "23:55"}`) : null
    const li = sop.limite && e.limiteFecha ? new Date(`${e.limiteFecha}T${e.limiteHora || "23:55"}`) : null
    if (ap && en && en < ap) return "Entrega no puede ser anterior a la apertura."
    if (ap && li && li < ap) return "Límite no puede ser anterior a la apertura."
    if (en && li && li < en) return "Límite no puede ser anterior a la entrega."
    return null
  }

  function buildBody(e: RowEdit, tipo: string) {
    const sop = soporta(tipo)
    const body: Record<string, unknown> = {}
    if (sop.apertura && e.abrirFecha)   { body.abrirFecha = e.abrirFecha;   body.abrirHora = e.abrirHora || "00:00" }
    if (sop.entrega  && e.entregaFecha) { body.entregaFecha = e.entregaFecha; body.entregaHora = e.entregaHora || "23:55" }
    if (sop.limite   && e.limiteFecha)  { body.limiteFecha = e.limiteFecha;  body.limiteHora = e.limiteHora || "23:55" }
    if (sop.intentos && e.intentos !== "") body.intentos = e.intentos === "-1" ? "Ilimitado" : parseInt(e.intentos, 10)
    return body
  }

  // ── Guardar una fila (PATCH + poll) ─────────────────────────────────────────
  function saveRow(fila: FilaConfig): Promise<boolean> {
    return new Promise(async (resolve) => {
      const e = edits[fila.evidenciaId]
      if (!e) return resolve(false)
      const err = validar(e, fila.tipo)
      if (err) { setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "error", msg: err } })); return resolve(false) }
      const body = buildBody(e, fila.tipo)
      if (Object.keys(body).length === 0) { setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "error", msg: "Nada para guardar." } })); return resolve(false) }

      setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "saving" } }))
      try {
        const { jobId } = await apiFetch<{ jobId: string }>(
          `/api/evidencias/${encodeURIComponent(fila.evidenciaId)}/config`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
        pollJobOnce(
          jobId,
          () => { setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "ok" } })); resolve(true) },
          (m) => { setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "error", msg: m } })); resolve(false) },
        )
      } catch (ex) {
        setRowState(p => ({ ...p, [fila.evidenciaId]: { phase: "error", msg: ex instanceof ApiError ? ex.message : "Error al guardar." } }))
        resolve(false)
      }
    })
  }

  async function saveSelected() {
    const seleccionadas = filas.filter(f => selected.has(f.evidenciaId))
    for (const fila of seleccionadas) {
      // eslint-disable-next-line no-await-in-loop
      await saveRow(fila)
    }
  }

  const totalSel = selected.size

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Toolbar */}
      <div className="p-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <Button size="sm" className="gap-2 bg-sena-green hover:bg-sena-green/90" onClick={cargarTodo} disabled={loadPhase === "loading"}>
          {loadPhase === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Cargar fechas de todas
        </Button>
        {loadMsg && (
          <span className={`text-sm ${loadPhase === "error" ? "text-red-600" : "text-blue-600"}`}>{loadMsg}</span>
        )}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" placeholder="Buscar evidencia..."
            className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-sena-green"
            value={search} onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="w-4 h-4 text-gray-400" /></button>}
        </div>
        {totalSel > 0 && (
          <Button size="sm" variant="outline" className="gap-1 border-sena-green text-sena-green" onClick={saveSelected}>
            <Save className="w-3.5 h-3.5" /> Guardar seleccionadas ({totalSel})
          </Button>
        )}
      </div>

      {/* Tabla */}
      {isLoading ? (
        <div className="p-8 text-center text-sm text-gray-500">Cargando…</div>
      ) : filas.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-500">No hay evidencias. Usa "Cargar fechas de todas" para leerlas desde Moodle.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100 bg-gray-50">
                <th className="px-2 py-2 w-8">
                  <button onClick={toggleSelAll} title="Seleccionar todas">
                    {selected.size === filas.length && filas.length > 0 ? <CheckSquare className="w-4 h-4 text-sena-green" /> : <Square className="w-4 h-4 text-gray-300" />}
                  </button>
                </th>
                <th className="px-2 py-2">Evidencia</th>
                <th className="px-2 py-2">Apertura</th>
                <th className="px-2 py-2">Entrega</th>
                <th className="px-2 py-2">Límite</th>
                <th className="px-2 py-2">Intentos</th>
                <th className="px-2 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filas.map(fila => {
                const e = edits[fila.evidenciaId] ?? emptyEdit()
                const sop = soporta(fila.tipo)
                const st = rowState[fila.evidenciaId] ?? { phase: "idle" as const }
                const sinLeer = !fila.config
                return (
                  <tr key={fila.evidenciaId} className={`border-b border-gray-50 last:border-0 hover:bg-gray-50 ${selected.has(fila.evidenciaId) ? "bg-blue-50/40" : ""}`}>
                    <td className="px-2 py-1.5 align-top">
                      <button onClick={() => toggleSel(fila.evidenciaId)}>
                        {selected.has(fila.evidenciaId) ? <CheckSquare className="w-4 h-4 text-sena-green" /> : <Square className="w-4 h-4 text-gray-300" />}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 max-w-[280px] align-top">
                      <p className="truncate text-gray-800" title={fila.nombre}>{fila.nombre}</p>
                      <span className="text-[10px] uppercase text-gray-400">{fila.tipo}{sinLeer && " · sin leer"}</span>
                    </td>
                    {/* Apertura */}
                    <td className="px-2 py-1.5 align-top">
                      <DateTimeCell enabled={sop.apertura} fecha={e.abrirFecha} hora={e.abrirHora}
                        onFecha={v => setField(fila.evidenciaId, "abrirFecha", v)} onHora={v => setField(fila.evidenciaId, "abrirHora", v)} />
                    </td>
                    {/* Entrega */}
                    <td className="px-2 py-1.5 align-top">
                      <DateTimeCell enabled={sop.entrega} fecha={e.entregaFecha} hora={e.entregaHora}
                        onFecha={v => setField(fila.evidenciaId, "entregaFecha", v)} onHora={v => setField(fila.evidenciaId, "entregaHora", v)} />
                    </td>
                    {/* Límite */}
                    <td className="px-2 py-1.5 align-top">
                      <DateTimeCell enabled={sop.limite} fecha={e.limiteFecha} hora={e.limiteHora}
                        onFecha={v => setField(fila.evidenciaId, "limiteFecha", v)} onHora={v => setField(fila.evidenciaId, "limiteHora", v)} />
                    </td>
                    {/* Intentos */}
                    <td className="px-2 py-1.5 align-top">
                      {sop.intentos ? (
                        <select className="h-7 rounded border border-gray-300 text-xs px-1"
                          value={e.intentos} onChange={ev => setField(fila.evidenciaId, "intentos", ev.target.value)}>
                          <option value="">—</option>
                          <option value="-1">Ilimitado</option>
                          {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={String(n)}>{n}</option>)}
                        </select>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    {/* Guardar + estado */}
                    <td className="px-2 py-1.5 align-top">
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => saveRow(fila)} disabled={st.phase === "saving"} title="Guardar esta fila">
                          {st.phase === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : st.phase === "ok" ? <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                            : st.phase === "error" ? <AlertCircle className="w-3.5 h-3.5 text-red-600" />
                            : <Save className="w-3.5 h-3.5 text-gray-500" />}
                        </Button>
                      </div>
                      {st.phase === "error" && st.msg && <p className="text-[10px] text-red-600 max-w-[120px]">{st.msg}</p>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Celda de fecha+hora reutilizable. Si !enabled muestra guion (tipo no lo soporta).
function DateTimeCell({ enabled, fecha, hora, onFecha, onHora }: {
  enabled: boolean; fecha: string; hora: string; onFecha: (v: string) => void; onHora: (v: string) => void
}) {
  if (!enabled) return <span className="text-gray-300 text-xs">—</span>
  return (
    <div className="flex flex-col gap-1">
      <Input type="date" className="h-7 text-xs w-32" value={fecha} onChange={e => onFecha(e.target.value)} />
      <Input type="time" step={300} className="h-7 text-xs w-24" value={hora} onChange={e => onHora(e.target.value)} disabled={!fecha} />
    </div>
  )
}

